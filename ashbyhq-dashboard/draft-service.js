/* =====================================================================
   PRE-APPLY DRAFT PASS.

   Given (applicant, link) and the cached job_link_fields, produce one
   applicant_field_answers row per scanned field, classifying each as:

     source = 'deterministic'  -> value resolved instantly from the applicant
                                  record via DERIVED_RULES (Tier 1/2). Shown
                                  to the CA under "auto-filled", read-only
                                  unless they choose to override.
     source = 'genai'          -> GenAI drafted a natural-language answer
                                  grounded on the record (Tier 3). CA must
                                  approve/edit before APPLY is enabled.
     source = 'missing_fact'   -> No data anywhere in the record and the
                                  model declined (correctly, per the
                                  grounded-only rule). CA must type a value
                                  or click "Use N/A" before APPLY.
     source = 'placeholder'    -> Tier-4 stand-in (N/A / 0) applied to a
                                  non-critical, non-choice field so the form
                                  would still submit if the CA leaves it.

   The pass is entirely browser-free; the worker's later submit run just
   replays the confirmed values into the DOM. This is what makes the flow
   fast: no live GenAI or human is on the critical path once APPLY is hit.
   ===================================================================== */
import { __internals } from '../genai-resume-filler.js';
import { toBool } from '../field-applier.js';
import { db } from './db/index.js';
import { listJobLinkFields, upsertFieldAnswer, listFieldAnswers, recordColumnVocabulary } from './db/store.js';
import { ensureFieldBindings } from './field-mapping.js';
import { resumeTextFor } from './resume-cache.js';

const {
  buildRecordMap, resolveDerived, flattenRecordText,
  generateFreeTextAnswer, generateChoiceAnswer,
  fieldQuestion, isChoiceField, matchOption, normalize, GoogleGenAI
} = __internals;

async function loadProfile(awlId) {
  const row = await db.prepare('SELECT profile_json FROM applicants WHERE awl_id = ?').get(awlId);
  if (!row) throw new Error(`No applicant ${awlId}`);
  try { return JSON.parse(row.profile_json || '{}'); } catch { return {}; }
}

// The privacy purge erases the snapshot once an application succeeds, so an
// applicant coming back for a NEW link legitimately has nothing stored. Pull it
// from the CRM again rather than drafting an empty record (which would mark
// every question missing_fact and blame GenAI for it).
async function requireProfile(awlId, log) {
  let profile = await loadProfile(awlId);
  if (Object.keys(buildRecordMap(profile)).length) return profile;
  log(`no stored profile for ${awlId} - re-fetching from the CRM`);
  try {
    const { syncApplicantByAwl, isConfigured } = await import('./connector/applicant-db.js');
    if (isConfigured()) await syncApplicantByAwl(awlId);
  } catch (err) {
    log(`CRM re-fetch failed: ${(err.message || String(err)).slice(0, 160)}`);
  }
  profile = await loadProfile(awlId);
  if (!Object.keys(buildRecordMap(profile)).length) {
    throw new Error(`Applicant ${awlId} has no data in the CRM (client_profiles / clients_additional_info) - nothing to fill from.`);
  }
  return profile;
}

// Turn a stored job_link_fields row into the shape resolveDerived / fieldQuestion
// expect from a live collectFields() field object.
function fieldFromRow(r) {
  return {
    kind: r.field_type,
    type: r.field_type === 'text' ? 'text' : r.field_type,
    questionText: r.question_text,
    label: '',
    name: r.field_key,
    id: r.field_key,
    placeholder: '',
    ariaLabel: '',
    options: r.options || []
  };
}

// Fields whose whole purpose is file uploads / autofill noise; nothing here can
// be answered by typing. Exported so the review pane can label them honestly
// instead of showing a question nobody can fill in.
export const IGNORE_RE = /autofill|cover letter|upload.*resume|resume upload|file upload|attach/i;

// Ashby (and most ATSes) prefix optional questions with "[Optional]" or
// "(optional)". We detect that once at draft time and store the flag on the
// answer row so the CA gate knows these gaps are non-blocking.
const OPTIONAL_RE = /^\s*[\[(]\s*optional\s*[\])]\s*[:\-]?\s*/i;

/**
 * Is this scanned question optional? ONE rule shared by the draft pass and the
 * review pane, because the two must never disagree about what locks APPLY.
 * `required` is the form's own tri-state marker (1 required / 0 optional /
 * NULL never said) and is the authority when present. The text prefix is the
 * fallback for links scanned before the marker was captured.
 * Note `Number(null) === 0` is true in JS, so a NULL must be tested for
 * explicitly - reading it as "optional" silently unblocked every unanswered
 * required question on a link whose scan predated the column.
 */
export function questionIsOptional(field) {
  const req = field?.required;
  if (req === 0 || req === '0' || req === false) return true;
  if (req === 1 || req === '1' || req === true) return false;
  return OPTIONAL_RE.test(String(field?.question_text || ''));
}

// Best-effort placeholder for an OPTIONAL text-family field whose value we
// won't invent. Radio / select / checkbox are excluded (never force Yes/No),
// and numeric / date boxes are excluded too - a fake "0" or "N/A" there is
// invalid data that Ashby rejects, so those fall through to 'missing_fact'.
function placeholderFor(kind, type) {
  if (/^(number|date|month|time)$/i.test(String(type || ''))) return null;
  if (kind === 'text' || kind === 'textarea' || kind === 'combobox') return 'N/A';
  return null;
}

// A value that comes from a column the MODEL named (rather than from a curated
// regex rule) may only land on a presented option by real equivalence: exact
// text, a whole word either way, or a genuine boolean. matchOption's looser
// substring test would answer a Yes/No knock-out with "No" just because the
// bound text contained the letters "no" inside a word.
function boundChoiceMatch(options, value) {
  const opts = (options || []).map(String);
  const nv = normalize(value);
  if (!opts.length || !nv) return null;
  const exact = opts.find((o) => normalize(o) === nv);
  if (exact !== undefined) return exact;
  const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const wholeWord = (hay, needle) => needle.length > 1 && new RegExp(`(^| )${esc(needle)}( |$)`).test(hay);
  const hit = opts.find((o) => wholeWord(nv, normalize(o)) || wholeWord(normalize(o), nv));
  if (hit !== undefined) return hit;
  const b = toBool(value);
  return b === null ? null : (opts.find((o) => toBool(o) === b) ?? null);
}

/* ------------------------------------------------------------------ */

/**
 * Run the pre-Apply draft pass for one (applicant, link) pair.
 * @param {string} awlId
 * @param {number} linkId
 * @param {object} opts { useGenai?: boolean, log?: (msg)=>void }
 * @returns {Promise<{ total:number, deterministic:number, genai:number, missing:number, placeholder:number, skipped:number, rows:Array }>}
 */
export async function runDraftPass(awlId, linkId, opts = {}) {
  const log = opts.log || ((m) => console.log(m));
  const useGenai = opts.useGenai !== false && !!process.env.GEMINI_API_KEY;
  const rows = await listJobLinkFields(linkId);
  if (!rows.length) throw new Error(`Link ${linkId} has no scanned fields yet — run scripts/scan-link.js first.`);

  const profile = await requireProfile(awlId, log);
  const recordMap = buildRecordMap(profile);
  const recordText = flattenRecordText(recordMap);

  // Ground the model on the resume too. A CRM record is 30-odd columns of
  // demographics and knock-out answers; "describe the most impressive thing you
  // built" is not in there, but it IS in the resume the applicant applied with.
  // Without this the narrative questions had nothing honest to cite, so they
  // declined and every essay landed on the CA.
  let resumeText = '';
  if (useGenai) {
    resumeText = await resumeTextFor(awlId, { log }).catch(() => '');
    if (resumeText) log(`resume grounded the draft (${resumeText.length} chars)`);
  }
  const context = [`PROVIDED APPLICANT RECORD:\n${recordText}`]
    .concat(resumeText ? [`APPLICANT RESUME (parsed text):\n${resumeText.slice(0, 9000)}`] : [])
    .join('\n\n');

  // Tier 2.5: which RECORD COLUMN does each question actually point at? The
  // verdict is a property of the link's questions, so it is computed once and
  // reused for every applicant (see field-mapping.js). Zero calls when the
  // link is already mapped - the normal case after the first applicant.
  const mapping = await ensureFieldBindings({
    linkId, rows, recordKeys: [...new Set([...Object.keys(recordMap), ...(await recordColumnVocabulary())])], log
  });
  const bindings = mapping.bindings;

  // CA authority: once a Career Associate has approved/edited a field it is the
  // FIXED value for that (applicant, link) — a later draft pass (re-scan, re-run,
  // quota recovery) must never recompute over it. We snapshot the existing rows
  // up front and skip any already stamped 'ca_edited'.
  const existingBy = new Map((await listFieldAnswers(awlId, linkId)).map((a) => [a.field_key, a]));
  const caLocked = (key) => existingBy.get(key)?.source === 'ca_edited';

  const ai = useGenai ? new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY }) : null;
  const outcome = {
    total: rows.length, deterministic: 0, bound: 0, genai: 0, missing: 0, placeholder: 0, skipped: 0,
    // What the CA/DEV needs to see about model usage for THIS pass.
    mappingCalls: mapping.calls, mappingError: mapping.error || null,
    resumeChars: resumeText.length, rows: []
  };

  // Standalone attestation / "I agree" checkboxes (a single box with no other
  // options) are auto-ticked by the automation - no GenAI, no CA decision.
  // Guard against "select all that apply" groups: if several checkbox fields
  // share the same question they are a multi-select, so leave those to a human.
  const cbCountByQuestion = new Map();
  for (const r of rows) {
    if (r.field_type === 'checkbox' && !(r.options && r.options.length)) {
      const k = String(r.question_text || '').toLowerCase().trim();
      cbCountByQuestion.set(k, (cbCountByQuestion.get(k) || 0) + 1);
    }
  }
  const isStandaloneCheckbox = (r) => r.field_type === 'checkbox' && !(r.options && r.options.length)
    && (cbCountByQuestion.get(String(r.question_text || '').toLowerCase().trim()) || 0) === 1;

  for (const r of rows) {
    if (caLocked(r.field_key)) { outcome.skipped += 1; continue; } // CA verdict is final
    const field = fieldFromRow(r);
    const q = fieldQuestion(field);
    // An upload box is not a question: store it as not_applicable (optional, no
    // value) so the review pane can still show it and the APPLY gate never locks
    // on it. Dropping the row entirely is what made questions disappear.
    if (IGNORE_RE.test(q)) {
      await upsertFieldAnswer({
        awlId, linkId, fieldKey: r.field_key, questionText: r.question_text,
        fieldType: r.field_type, options: r.options, value: null,
        source: 'not_applicable', evidence: ['file upload - the run attaches the resume'],
        sortOrder: r.sort_order, optional: 1
      });
      outcome.skipped += 1;
      outcome.rows.push({ key: r.field_key, source: 'not_applicable', question: r.question_text });
      continue;
    }
    // Required-ness comes from the FORM (label._required / "*" / "(optional)"),
    // captured at scan time; the "[Optional]" text prefix is only a fallback for
    // links scanned before that marker existed.
    const optional = questionIsOptional(r) ? 1 : 0;

    const isChoice = r.field_type === 'radio' || r.field_type === 'select' || r.field_type === 'checkbox';

    // Auto-attest a single standalone checkbox: value 'true' makes the submit
    // run's applyCheckbox tick the one box. Shown to the CA as auto-filled.
    if (isStandaloneCheckbox(r)) {
      await upsertFieldAnswer({
        awlId, linkId, fieldKey: r.field_key, questionText: r.question_text,
        fieldType: r.field_type, options: r.options, value: 'true',
        source: 'deterministic', evidence: ['auto-attested (single checkbox)'], sortOrder: r.sort_order, optional
      });
      outcome.deterministic += 1;
      outcome.rows.push({ key: r.field_key, source: 'deterministic', value: 'true', question: r.question_text });
      continue;
    }

    // Tier 1/2: deterministic derived value from the record (no API).
    // For a choice field the derived value must land on one of the presented
    // options. matchOption coerces beyond plain text: a true/false or Yes/No
    // maps to the option spelled either way, and a salary number/range maps to
    // the bracket that overlaps it. If nothing matches we reject and let Tier
    // 3 / the CA handle it, rather than writing a value the form can't accept.
    let derived = resolveDerived(field, recordMap, profile);
    if (derived && isChoice) {
      const matched = matchOption(r.options || [], derived);
      if (matched) derived = matched;
      else {
        log(`Rejecting derived choice-value for "${r.field_key}": "${derived}" not in [${(r.options || []).join(' | ')}]`);
        derived = '';
      }
    }
    if (derived) {
      await upsertFieldAnswer({
        awlId, linkId, fieldKey: r.field_key, questionText: r.question_text,
        fieldType: r.field_type, options: r.options, value: derived,
        source: 'deterministic', evidence: [], sortOrder: r.sort_order, optional
      });
      outcome.deterministic += 1;
      outcome.rows.push({ key: r.field_key, source: 'deterministic', question: r.question_text, value: derived });
      continue;
    }

    // Tier 2.5: the mapper identified WHICH COLUMN this question points at, so
    // the automation reads the applicant's own value verbatim. The model named
    // the source; it never wrote the answer. A value that has to land on a
    // presented option is still coerced through matchOption, and a miss is
    // dropped rather than guessed.
    const boundKey = bindings.get(r.field_key);
    if (boundKey) {
      let value = recordMap[normalize(boundKey)] || '';
      if (value && isChoice) {
        const matched = boundChoiceMatch(r.options || [], value);
        if (!matched) {
          log(`Bound column "${boundKey}" = "${value}" is not one of the options for "${r.field_key}" - leaving to the next tier`);
          value = '';
        } else value = matched;
      }
      if (value) {
        await upsertFieldAnswer({
          awlId, linkId, fieldKey: r.field_key, questionText: r.question_text,
          fieldType: r.field_type, options: r.options, value,
          source: 'deterministic', evidence: [`record column: ${boundKey}`], sortOrder: r.sort_order, optional
        });
        outcome.bound += 1;
        outcome.rows.push({ key: r.field_key, source: 'deterministic', via: 'bound', question: r.question_text, value });
        continue;
      }
    }

    // Tier 3: GenAI draft — always grounded, never invented. Reached only when
    // no rule and no bound column could source the value: i.e. genuinely
    // narrative questions ("what excites you about X?") and facts the CRM has.
    let draft = null;
    let aiErrored = null;
    if (ai) {
      try {
        if (isChoiceField(field)) {
          const res = await generateChoiceAnswer(ai, q, field.options, context);
          if (res.canAnswerTruthfully && res.selectedOption && res.selectedOption !== '__UNANSWERABLE__') {
            draft = { value: res.selectedOption, evidence: res.evidence || [] };
          }
        } else {
          const res = await generateFreeTextAnswer(ai, q, context);
          if (res.canAnswerTruthfully && res.responseText) {
            draft = { value: res.responseText, evidence: res.evidence || [] };
          }
        }
      } catch (err) {
        aiErrored = err.message || String(err);
        log(`GenAI error on "${r.field_key}": ${aiErrored.slice(0, 200)}`);
      }
      if (draft) {
        await upsertFieldAnswer({
          awlId, linkId, fieldKey: r.field_key, questionText: r.question_text,
          fieldType: r.field_type, options: r.options, value: draft.value,
          source: 'genai', evidence: draft.evidence, sortOrder: r.sort_order, optional
        });
        outcome.genai += 1;
        outcome.rows.push({ key: r.field_key, source: 'genai', value: draft.value, question: r.question_text });
        continue;
      }
    }

    // GenAI *error* (quota / network / timeout) is distinct from GenAI
    // *declining* a question for lack of data. On error, surface as
    // 'missing_fact' regardless of field type so the CA sees the red
    // section, understands the reason, and can either fill it manually
    // or click Use N/A. Silent placeholders would hide the failure.
    if (aiErrored) {
      await upsertFieldAnswer({
        awlId, linkId, fieldKey: r.field_key, questionText: r.question_text,
        fieldType: r.field_type, options: r.options, value: null,
        source: 'missing_fact', evidence: [`GenAI unavailable: ${aiErrored.slice(0, 160)}`], sortOrder: r.sort_order, optional
      });
      outcome.missing += 1;
      outcome.rows.push({ key: r.field_key, source: 'missing_fact', value: null, question: r.question_text, reason: 'ai_error' });
      continue;
    }

    // Tier 4 vs category C:
    //   - OPTIONAL text-family field with no data -> placeholder (safe N/A).
    //   - REQUIRED field with no real answer -> 'missing_fact' so the CA is
    //     prompted. We must NEVER silently N/A a required field: that hides
    //     the gap from the review pane, slips past the APPLY gate, and gets
    //     rejected by Ashby at submit (e.g. "N/A" in a date / year box).
    const ph = optional ? placeholderFor(r.field_type, field.type) : null;
    if (ph) {
      await upsertFieldAnswer({
        awlId, linkId, fieldKey: r.field_key, questionText: r.question_text,
        fieldType: r.field_type, options: r.options, value: ph,
        source: 'placeholder', evidence: [], sortOrder: r.sort_order, optional
      });
      outcome.placeholder += 1;
      outcome.rows.push({ key: r.field_key, source: 'placeholder', value: ph, question: r.question_text });
    } else {
      await upsertFieldAnswer({
        awlId, linkId, fieldKey: r.field_key, questionText: r.question_text,
        fieldType: r.field_type, options: r.options, value: null,
        source: 'missing_fact', evidence: [], sortOrder: r.sort_order, optional
      });
      outcome.missing += 1;
      outcome.rows.push({ key: r.field_key, source: 'missing_fact', value: null, question: r.question_text });
    }
  }
  return outcome;
}

/* ------------------------------------------------------------------ */

/**
 * Every question the CA has to see for one (applicant, link) - built from the
 * link's scanned INVENTORY, not from the answer rows.
 *
 * The review pane used to render whatever applicant_field_answers happened to
 * exist. That made it silently lose questions: a re-scan that reworded a caption
 * (the "Start typing..." -> "Location" fix) pruned the stale keys, an applicant
 * whose draft pass never ran got an empty pane, and a field skipped mid-loop just
 * vanished - in every case with APPLY locked and no explanation. The form itself
 * is the source of truth for WHICH questions exist; the answer row only carries
 * what we worked out for it. So a question with no row is still shown, typed and
 * optioned exactly as the form asks it, and marked 'needs_input'.
 */
export async function buildReviewQuestions(awlId, linkId) {
  const inventory = await listJobLinkFields(linkId);
  const answers = await listFieldAnswers(awlId, linkId);
  const byKey = new Map(answers.map((a) => [a.field_key, a]));
  const out = [];
  for (const f of inventory) {
    const a = byKey.get(f.field_key);
    // The FORM decides required-ness, not the draft row: an answer written by an
    // earlier pass carries an `optional` flag computed under older rules.
    const optional = questionIsOptional(f);
    const required = !optional;
    out.push({
      field_key: f.field_key,
      question_text: f.question_text,
      question_summary: f.question_summary || null,
      field_type: f.field_type,
      options: f.options || [],
      value: a ? a.value : null,
      source: a ? a.source : 'needs_input',
      evidence: a ? a.evidence : [],
      required: required ? 1 : 0,
      // The existing review UI keys off `optional`, so both spellings travel.
      optional: optional ? 1 : 0,
      sort_order: f.sort_order,
      drafted_at: a?.drafted_at || null,
      updated_at: a?.updated_at || null
    });
  }
  // A stored answer whose question left the form: keep showing it (a CA decision
  // must never disappear) but flag it, because there is no control to replay it
  // onto any more.
  const live = new Set(inventory.map((f) => f.field_key));
  for (const a of answers) {
    if (live.has(a.field_key)) continue;
    out.push({ ...a, required: !Number(a.optional), optional: Number(a.optional) ? 1 : 0, stale: true });
  }
  return out;
}

/* ------------------------------------------------------------------ */

// Read every row that a submit run should replay into the live form. Ordered
// Includes deterministic + genai + ca_edited + placeholder. 'missing_fact'
// rows with null value are excluded — the submit run must not send blanks.
export async function listConfirmedAnswers(awlId, linkId) {
  const rows = await db.prepare(`SELECT field_key, question_text, field_type, options_json, value, source
    FROM applicant_field_answers
    WHERE awl_id = ? AND link_id = ? AND value IS NOT NULL AND value <> ''
    ORDER BY sort_order, id`).all(awlId, linkId);
  return rows.map((r) => ({ ...r, options: JSON.parse(r.options_json || '[]') }));
}

// Convenience: given an application id, resolve its (awl_id, link_id) pair.
export async function answersForApplication(appId) {
  const row = await db.prepare('SELECT a.awl_id, a.link_id FROM applications a WHERE a.id = ?').get(appId);
  if (!row) return null;
  return { awlId: row.awl_id, linkId: row.link_id };
}
