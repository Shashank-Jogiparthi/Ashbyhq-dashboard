/* =====================================================================
   SEMANTIC QUESTION BINDING  (the Tier-2.5 the deterministic rules miss)

   WHY THIS EXISTS
   The deterministic layer (DERIVED_RULES in genai-resume-filler.js) is a list
   of ~30 hand-written regexes. When an employer words a question differently
   than any regex expects, the old behaviour was to hand the question straight
   to GenAI and let it WRITE THE ANSWER - so the model got called for things
   the applicant's own CRM row already stated verbatim, and every applicant on
   the same job link paid for the same question again.

   WHAT HAPPENS INSTEAD
   GenAI is asked the only question it is actually good at here: "this question
   points at exactly one fact; WHICH COLUMN of the record holds it?" The
   wording varies, the fact does not. It returns a column name; the
   AUTOMATION reads the value itself, so the number that reaches the form is
   the CRM's own text, never a model's paraphrase.

   COST SHAPE
   The verdict belongs to the QUESTION, not to the applicant, so it is stored
   on job_link_fields.bound_key - one batched call per link, reused for every
   applicant who ever applies to it, and re-used across re-scans. A link whose
   questions are all bound is drafted with ZERO model calls.

   Concurrency: many applicants can hit an unbound link at the same instant.
   `inflight` collapses those into one call, and `cooldown` stops a quota
   error from being retried by every one of them.
   ===================================================================== */
import { __internals } from '../genai-resume-filler.js';
import { db } from './db/index.js';
import { saveFieldBindings } from './db/store.js';

const { mapQuestionsToRecord, GoogleGenAI } = __internals;

const CHUNK = 40;                       // questions per request
const FAIL_COOLDOWN_MS = 10 * 60 * 1000; // don't stampede after a quota error
// Gemini answers this kind of call in ~1-2s but sheds load with 503/429 when it
// is busy, so a couple of short waits beat treating the link as unmappable.
const ATTEMPTS = 3;
const BACKOFF_MS = [4000, 12000];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const inflight = new Map();             // linkId -> Promise
const cooldown = new Map();             // linkId -> epoch-ms until which we won't retry

/**
 * Make sure every question on a link has a binding verdict, and return them.
 * @param {object} p
 * @param {number} p.linkId
 * @param {Array} p.rows  current job_link_fields rows (need field_key, question_text, bound_key)
 * @param {string[]} p.recordKeys  the applicant record's available columns
 * @param {(msg:string)=>void} [p.log]
 * @returns {Promise<{ bindings: Map<string,string>, calls: number, mapped: number, error: string|null }>}
 */
export async function ensureFieldBindings({ linkId, rows, recordKeys, log = () => {} } = {}) {
  const pending = (rows || []).filter((r) => r.bound_key === null || r.bound_key === undefined);
  const readBack = async () => {
    const all = await db.prepare('SELECT field_key, bound_key FROM job_link_fields WHERE link_id = ?').all(linkId);
    return new Map(all.map((r) => [r.field_key, String(r.bound_key ?? '')]));
  };
  if (!pending.length || !recordKeys.length) {
    return { bindings: await readBack(), calls: 0, mapped: 0, error: null };
  }
  if (!process.env.GEMINI_API_KEY) {
    // No model available: leave the rows unbound (NOT bound to '') so the next
    // applicant retries once a key is configured.
    return { bindings: await readBack(), calls: 0, mapped: 0, error: 'no_api_key' };
  }
  if ((cooldown.get(Number(linkId)) || 0) > Date.now()) {
    return { bindings: await readBack(), calls: 0, mapped: 0, error: 'cooldown' };
  }

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const questions = pending.map((r) => ({ key: r.field_key, text: String(r.question_text || '').slice(0, 600) }));
  let error = null;
  let calls = 0;
  let boundCount = 0;
  const merged = {};

  // Collapse simultaneous callers on this link into a single mapping run.
  const key = Number(linkId);
  if (inflight.has(key)) {
    const bindings = await inflight.get(key);
    return { bindings, calls: 0, mapped: bindings.size, error: null };
  }

  const run = (async () => {
    try {
      for (let i = 0; i < questions.length; i += CHUNK) {
        const batch = questions.slice(i, i + CHUNK);
        for (let attempt = 0; ; attempt += 1) {
          try {
            calls += 1;
            Object.assign(merged, await mapQuestionsToRecord(ai, batch, recordKeys));
            break;
          } catch (err) {
            if (attempt >= ATTEMPTS - 1) throw err;
            const wait = BACKOFF_MS[Math.min(attempt, BACKOFF_MS.length - 1)];
            log(`question mapping hit a transient error (attempt ${attempt + 1}/${ATTEMPTS}): ${String(err?.message || err).slice(0, 120)} - retrying in ${wait / 1000}s`);
            await sleep(wait);
          }
        }
      }
    } catch (err) {
      error = err?.message || String(err);
      log(`field mapping failed for link ${key}: ${error.slice(0, 160)}`);
      cooldown.set(key, Date.now() + FAIL_COOLDOWN_MS);
    }
    const stored = Object.keys(merged);
    if (stored.length) await saveFieldBindings(key, merged);
    boundCount = stored.filter((k) => merged[k]).length;
    log(`field mapping for link ${key}: ${calls} call(s), ${boundCount}/${stored.length} question(s) bound to a record column, ${stored.length - boundCount} essay/unmappable`);
    return readBack();
  })();

  inflight.set(key, run);
  try {
    const bindings = await run;
    return { bindings, calls, mapped: boundCount, error };
  } finally {
    inflight.delete(key);
  }
}

// Exposed for the DEV surface / tests: has this link been fully mapped yet?
export async function bindingCoverage(linkId) {
  const row = await db.prepare(`SELECT COUNT(1) AS total,
    SUM(CASE WHEN bound_key IS NULL THEN 1 ELSE 0 END) AS unmapped
    FROM job_link_fields WHERE link_id = ?`).get(Number(linkId));
  const total = Number(row?.total || 0);
  const unmapped = Number(row?.unmapped || 0);
  return { total, unmapped, bound: total - unmapped, complete: total > 0 && unmapped === 0 };
}
