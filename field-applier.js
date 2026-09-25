/* =====================================================================
   Playwright field-application layer.

   This is the "hands" of the automation: given a control on the page and
   a value that the resolver (GenAI or the deterministic resume mapping)
   decided on, it performs the correct mechanical interaction for that
   control TYPE. The model only ever produces a value; everything about
   HOW to fill a radio vs. a dropdown vs. a type-ahead combobox lives here.

   Supported kinds:
     text        -> type into an input[type=text]
     textarea    -> type into a <textarea>
     select      -> choose a native <option> by its label
     radio       -> check the radio whose label matches the value
     checkbox    -> check / uncheck based on a yes/no value
     combobox    -> open an Ashby-style type-ahead, type the value,
                    then click the matching suggestion from the popup

   Every applier is defensive: a failed interaction is reported, never
   thrown, so one awkward widget can't abort the whole run.

   Interactions are routed through the human-behavior layer (humanize.js):
   curved cursor travel, per-keystroke typing, real press dwell - each with a
   plain-Playwright fallback so a cosmetic failure never breaks correctness.
   ===================================================================== */

import { humanClick, humanType, moveToLocator, pause } from './humanize.js';

export function norm(value = '') {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// Pick the option whose text best matches the resolved value.
// Beyond plain text, it understands:
//   - boolean <-> Yes/No equivalence (true/false/1/0 and yes/no, either way),
//   - numeric / salary-range overlap (a value like "100000-130000" matches an
//     option "100K to 130K"), so compensation picks the right bracket.
export function matchOption(options, value) {
  const opts = (options || []).map((o) => String(o));
  if (!opts.length) return null;
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const want = norm(raw);
  if (!want) return null;
  // 1) exact, then substring (previous behaviour)
  const direct = opts.find((o) => norm(o) === want)
    || opts.find((o) => norm(o).includes(want) || want.includes(norm(o)));
  if (direct) return direct;
  // 2) boolean / Yes-No coercion
  const b = toBool(raw);
  if (b !== null) {
    const boolHit = opts.find((o) => toBool(o) === b);
    if (boolHit) return boolHit;
  }
  // 3) numeric / range overlap (choose the bracket with the greatest overlap)
  const nums = extractNumbers(raw);
  if (nums.length) {
    let best = null;
    let bestScore = 0;
    for (const o of opts) {
      const on = extractNumbers(o);
      if (!on.length) continue;
      const score = rangeOverlap(nums, on);
      if (score > bestScore) { bestScore = score; best = o; }
    }
    if (best) return best;
  }
  return null;
}

const YES_TOKENS = new Set(['yes', 'true', 'y', '1']);
const NO_TOKENS = new Set(['no', 'false', 'n', '0']);

// Recognise a boolean/yes-no cell as true/false, or null when it isn't one.
export function toBool(value) {
  const t = norm(value);
  if (YES_TOKENS.has(t)) return true;
  if (NO_TOKENS.has(t)) return false;
  return null;
}

// Pull numeric tokens out of free text, honouring k/m suffixes, thousands
// separators, $ signs and simple ranges ("100K to 130K", "80-100", "$130,000").
export function extractNumbers(text) {
  const out = [];
  const re = /(\d[\d,\.]*)\s*([km])?/gi;
  let m;
  while ((m = re.exec(String(text ?? ''))) !== null) {
    let n = parseFloat(m[1].replace(/,/g, ''));
    if (!isFinite(n)) continue;
    const suf = (m[2] || '').toLowerCase();
    if (suf === 'k') n *= 1000; else if (suf === 'm') n *= 1e6;
    out.push(n);
  }
  return out;
}

// Overlap score between two numeric sets (treated as [min,max] spans). 0 when
// they don't intersect; larger = tighter match. A point inside the other span
// counts weakly so a single value still finds its bracket.
function rangeOverlap(a, b) {
  const [amin, amax] = a.length >= 2 ? [Math.min(...a), Math.max(...a)] : [a[0], a[0]];
  const [bmin, bmax] = b.length >= 2 ? [Math.min(...b), Math.max(...b)] : [b[0], b[0]];
  const inter = Math.max(0, Math.min(amax, bmax) - Math.max(amin, bmin));
  if (inter > 0) return inter + 1;
  const contained = (amin >= bmin && amax <= bmax) || (bmin >= amin && bmax <= amax);
  return contained ? 1 : 0;
}

const SCAN_SELECTOR =
  'input:not([type="hidden"]), textarea, select, [role="combobox"], button[data-option]';

// A grouped control (radio set, Ashby Yes/No pair) shares ONE caption, so the
// required marker is the same for every member. Tri-state: any member that says
// "required" wins, otherwise a member that says "optional", otherwise unknown.
function groupRequired(members) {
  if (members.some((mm) => mm.required === true)) return true;
  if (members.some((mm) => mm.required === false)) return false;
  return null;
}

// Inspect every candidate control in document order and classify it.
export async function collectFields(page) {
  const handles = await page.locator(SCAN_SELECTOR).all();
  const metas = await page.evaluate((sel) => {
    // Ashby puts the question in a <p>/label ABOVE the radio group, so the
    // radio's closest container only yields "Yes No". Climb ancestors until we
    // find one that actually contains a sentence (the question).
    function climbQuestion(node) {
      for (let up = 0; up < 6 && node; up++) {
        node = node.parentElement;
        if (!node) break;
        const t = (node.textContent || '').replace(/\s+/g, ' ').trim();
        if (t.length >= 18 && (t.includes('?') || t.split(/\s+/).length >= 4)) return t;
      }
      return '';
    }
    // --- real question caption -------------------------------------------
    // A control's question is the caption printed NEXT TO it, not its
    // placeholder. Ashby renders most of them as <label>Full Name*</label>,
    // but its type-ahead widgets (Location) are React components whose input
    // has NO label association at all - the caption is a plain sibling. Without
    // this the scan stored "Start typing..." as the question, the review pane
    // showed a question nobody asked, nothing matched the record, and Ashby
    // rejected the submit with "Missing entry for required field: Location".
    const textOf = (node) => (node ? String(node.textContent || '').replace(/\s+/g, ' ').trim() : '');
    // Ashby ships stable class names that separate the QUESTION from the text
    // that merely sits next to it. Verified against a live form: the caption is
    // always <label class="_heading ...">Gender</label> while "Input gender" and
    // the long "Hispanic or Latino - A person of Cuban..." paragraphs are
    // .ashby-application-form-question-description, and section titles are
    // .ashby-application-form-section-header. Missing this is what made the EEO
    // groups read "GenderInput genderMaleFemale..." to the CA.
    const HELPER_RE = /question-description|section-header|blocking-disclosure|_description_|help[-_ ]?text|hint/i;
    // Accept only a caption-shaped node: text, and not a container that also
    // holds controls (that would be a whole form section, not a question - and
    // for a radio group it would be the option's own label). Long questions are
    // still questions, so the ceiling is a paragraph, not a phrase.
    function shortLabel(node) {
      if (!node || node.nodeType !== 1) return '';
      if (node.querySelector('input, textarea, select, [role="combobox"], button[data-option]')) return '';
      if (HELPER_RE.test(String(node.className || ''))) return '';
      const t = textOf(node);
      if (!t || t.length > 320) return '';
      return t.replace(/[\s]*[*:]\s*$/, '').replace(/\s*\(optional\)\s*$/i, '').trim();
    }
    const CAPTION_SEL = 'label, legend, p, span, div, h1, h2, h3, h4';
    const SKIP_SIBLING = /^(INPUT|TEXTAREA|SELECT|BUTTON|SVG|IMG|SCRIPT|STYLE|NOSCRIPT)$/;
    // Text captions sitting directly before a control, nearest first.
    function captionsBefore(container) {
      const out = [];
      for (let s = container.previousElementSibling, k = 0; s && k < 5; s = s.previousElementSibling, k += 1) {
        if (SKIP_SIBLING.test(s.tagName)) continue;
        if (HELPER_RE.test(String(s.className || ''))) continue;   // helper text, not a question
        const direct = shortLabel(s);
        if (direct) { out.push(direct); continue; }
        if (s.querySelectorAll) {
          for (const inner of s.querySelectorAll(CAPTION_SEL)) {
            if (HELPER_RE.test(String(inner.className || ''))) continue;
            const t = shortLabel(inner);
            if (t) { out.push(t); break; }
          }
        }
      }
      return out;
    }
    function nearestQuestion(el, skipOwnLabel) {
      // 1. explicit association: wrapping label, label[for=id], aria-labelledby.
      //    Skipped for radios - their own label IS the option text.
      if (!skipOwnLabel) {
        const assoc = [el.closest && el.closest('label')];
        if (el.id) {
          try { assoc.push(document.querySelector(`label[for="${CSS.escape(el.id)}"]`)); } catch { /* odd id */ }
        }
        for (const id of String(el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean)) {
          try { assoc.push(document.getElementById(id)); } catch { /* ignore */ }
        }
        for (const a of assoc) { const t = shortLabel(a); if (t) return t; }
      }
      // 2. the caption inside the control's OWN wrapper, nearest first. A
      //    question mark wins over a helper line ("Write N/A if non-applicable"
      //    sits beside the real question on Ashby long-form fields).
      for (let node = el, up = 0; node && up < 5; node = node.parentElement, up += 1) {
        const cands = captionsBefore(node);
        if (cands.length) return cands.find((t) => t.includes('?')) || cands[0];
      }
      return '';
    }
    // Is the question REQUIRED? The CA gate needs the real answer, not a guess:
    // shortLabel() strips the trailing "*" / "(optional)" off the caption (the CA
    // should read the question, not the markup), so the marker has to be read
    // here, from the raw text and Ashby's own class. true / false / null = the
    // form never said, which the gate treats as required (safe direction).
    function requiredFlag(el) {
      if (el.required === true || el.getAttribute('aria-required') === 'true') return true;
      const seen = [];
      if (el.closest && el.closest('label')) seen.push(el.closest('label'));
      if (el.id) {
        try { const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`); if (l) seen.push(l); } catch { /* odd id */ }
      }
      for (let node = el, up = 0; node && up < 5; node = node.parentElement, up += 1) {
        for (let s = node.previousElementSibling, k = 0; s && k < 5; s = s.previousElementSibling, k += 1) {
          if (!SKIP_SIBLING.test(s.tagName)) seen.push(s);
        }
      }
      for (const n of seen) {
        const cls = String(n.className || '');
        const t = textOf(n);
        if (/\(optional\)|\[optional\]/i.test(t)) return false;
        if (/_required\b/.test(cls) || /\*\s*$/.test(t)) return true;
      }
      return null;
    }
    return Array.from(document.querySelectorAll(sel)).map((el) => {
      const label = el.closest('label') ||
        (el.id && document.querySelector(`label[for="${el.id}"]`));
      const fieldset = el.closest('fieldset');
      const legend = fieldset && fieldset.querySelector('legend');
      // Ashby Yes/No: a hidden checkbox + two <button data-option> siblings,
      // question in <label for="<uuid>">. Treat the button pair as a radio group.
      const yesnoContainer = el.closest && el.closest('.ashby-application-form-input-yesno, [class*="yesno"]:not([data-option])');
      const isYesNoOption = !!(el.matches && el.matches('button[data-option]'));
      let yesGroup = '';
      let yesQuestion = '';
      if (isYesNoOption && yesnoContainer) {
        const holder = yesnoContainer.querySelector('input');
        yesGroup = (holder && holder.name) || yesnoContainer.getAttribute('data-field-path') || '';
        const qlabel = (holder && holder.name && document.querySelector(`label[for="${holder.name}"]`)) || yesnoContainer.querySelector('label');
        yesQuestion = ((qlabel && qlabel.textContent) || '').replace(/\s+/g, ' ').trim();
      }
      const optionEls = el.tagName === 'SELECT'
        ? Array.from(el.options).map((o) => (o.textContent || '').trim())
          .filter((t) => t && !/^(select|choose|please select|--|n\/?a)$/i.test(t))
        : [];
      return {
        tag: el.tagName.toLowerCase(),
        type: (el.type || '').toLowerCase(),
        role: el.getAttribute('role') || '',
        name: el.name || '',
        id: el.id || '',
        placeholder: el.placeholder || el.getAttribute('placeholder') || '',
        ariaLabel: el.getAttribute('aria-label') || '',
        hasPopup: el.getAttribute('aria-haspopup') || '',
        ariaAutocomplete: el.getAttribute('aria-autocomplete') || '',
        value: el.value || '',
        checked: !!el.checked,
        selectedText: el.options
          ? Array.from(el.options).filter((o) => o.selected).map((o) => (o.textContent || '').trim()).join(', ')
          : '',
        disabled: !!el.disabled || el.getAttribute('aria-disabled') === 'true',
        visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length)
          || !!(label && (label.offsetWidth || label.offsetHeight || label.getClientRects().length)),
        optionLabel: (label ? label.textContent : '') || '',
        // "Location" / "Gender": the caption of THIS control only. For a radio
        // the option's own label is never the question, so the association step
        // is skipped and only the wrapper caption is trusted (this is what made
        // the EEO groups read "GenderInput genderMaleFemale...").
        nearQuestion: isYesNoOption ? '' : nearestQuestion(el, el.type === 'radio'),
        required: requiredFlag(el),
        legendText: shortLabel(legend),
        questionText: `${legend?.textContent || ''} ${label?.textContent || ''} ${el.name || ''} ${el.id || ''} ${el.getAttribute('aria-label') || ''} ${el.placeholder || ''}`.trim(),
        radioQuestion: el.type === 'radio' ? climbQuestion(el) : '',
        labelText: `${legend?.textContent || ''} ${label?.textContent || ''} ${el.getAttribute('aria-label') || ''}`.replace(/\s+/g, ' ').trim(),
        isYesNoOption,
        yesGroup,
        yesQuestion,
        yesOption: (el.getAttribute && el.getAttribute('data-option')) || '',
        yesText: isYesNoOption ? (el.textContent || '').trim() : '',
        inYesNo: !isYesNoOption && !!yesnoContainer,
        pressed: !!(el.getAttribute && el.getAttribute('aria-pressed') === 'true'),
        options: optionEls
      };
    });
  }, SCAN_SELECTOR).catch(() => []);

  const fields = [];
  const radioGroups = new Map();
  const yesGroups = new Map();

  metas.forEach((m, i) => {
    if (!m.visible || m.disabled) return;
    if (m.inYesNo) return;            // the hidden state checkbox behind an Ashby Yes/No
    const locator = handles[i];

    if (m.isYesNoOption) {
      const key = m.yesGroup || norm(m.yesQuestion);
      if (!yesGroups.has(key)) yesGroups.set(key, { question: m.yesQuestion, members: [] });
      yesGroups.get(key).members.push({ locator, i, optionLabel: m.yesText || m.yesOption, optionValue: m.yesOption, pressed: m.pressed, required: m.required });
      return;
    }

    if (m.tag === 'select') {
      fields.push({ kind: 'select', locator, i, ...m, answered: !!m.value });
    } else if (m.type === 'radio') {
      const key = m.name || norm(m.questionText);
      if (!radioGroups.has(key)) radioGroups.set(key, []);
      radioGroups.get(key).push({ locator, i, optionLabel: norm(m.optionLabel) ? m.optionLabel : m.value, checked: m.checked, questionText: m.questionText, radioQuestion: m.radioQuestion, legendText: m.legendText, nearQuestion: m.nearQuestion, required: m.required });
    } else if (m.type === 'checkbox') {
      fields.push({ kind: 'checkbox', locator, i, ...m, answered: m.checked });
    } else if (m.tag === 'textarea') {
      fields.push({ kind: 'textarea', locator, i, ...m, answered: !!m.value.trim() });
    } else if (
      m.role === 'combobox' || m.hasPopup === 'listbox' || m.hasPopup === 'menu' ||
      m.ariaAutocomplete === 'list' || m.ariaAutocomplete === 'both' ||
      /start typing|type to search|search\.\.\.|select\.\.\.|choose\.\.\./i.test(m.placeholder)
    ) {
      fields.push({ kind: 'combobox', locator, i, ...m, answered: !!m.value.trim() });
    } else if (m.type === 'text' || m.type === '' || m.type === 'number' || m.type === 'email' || m.type === 'tel' || m.type === 'url') {
      fields.push({ kind: 'text', locator, i, ...m, answered: !!String(m.value || '').trim() });
    }
    // search/email/tel/url/number/date/file + hidden are left to the engine or skipped.
  });

  for (const members of radioGroups.values()) {
    const answered = members.some((mm) => mm.checked);
    const options = members.map((mm) => mm.optionLabel).filter(Boolean);
    if (!options.length) continue;
    fields.push({
      kind: 'radio', members, options, answered,
      i: members[0].i,
      required: groupRequired(members),
      // The group's caption is the caption of its FIRST radio (the option labels
      // are excluded inside nearestQuestion), so "Gender" / "Race" survive
      // instead of the concatenated blob.
      legendText: (members.find((mm) => mm.legendText) || {}).legendText || '',
      nearQuestion: (members.find((mm) => mm.nearQuestion) || {}).nearQuestion || '',
      questionText: (members.find((mm) => mm.radioQuestion)?.radioQuestion)
        || (members.find((mm) => mm.questionText)?.questionText) || options.join(' '),
      locator: members[0].locator
    });
  }

  for (const g of yesGroups.values()) {
    const options = g.members.map((mm) => mm.optionLabel).filter(Boolean);
    if (!options.length) continue;
    fields.push({
      kind: 'radio', members: g.members, options,
      required: groupRequired(g.members),
      answered: g.members.some((mm) => mm.pressed),
      i: g.members[0].i,
      questionText: g.question || options.join(' '),
      locator: g.members[0].locator
    });
  }

  return fields;
}

/* -------------------------- type-specific I/O ----------------------- */

async function applyText(page, locator, value) {
  const typed = await humanType(page, locator, value).catch(() => false);
  if (!typed) await locator.fill(String(value)).catch(() => {});
}

async function applySelect(page, field, value) {
  let chosen = matchOption(field.options, value);
  if (!chosen) {
    // The scan can legitimately capture no list or a partial one (a long,
    // virtualised dropdown). The LIVE control still holds every option, so ask
    // it directly - that is what lets a CA-typed answer land on the choice it
    // names instead of failing the field.
    const live = await field.locator.evaluate(
      (el) => Array.from(el.options || []).map((o) => String(o.textContent || o.value || '').trim())
    ).catch(() => []);
    chosen = matchOption(live, value);
  }
  if (!chosen) return false;
  // Idempotent: if the live control already shows the chosen option, leave it
  // alone. Without this the authoritative replay re-selects what the resume
  // matcher already set, which reads as a deselect/re-select flicker.
  const cur = await field.locator.evaluate((el) => (el.selectedOptions && el.selectedOptions[0] ? (el.selectedOptions[0].text || '').trim() : '')).catch(() => '');
  if (norm(cur) === norm(chosen)) return true;
  await moveToLocator(page, field.locator).catch(() => {}); // pointer trail before choosing
  await pause(page, 80, 220);
  await field.locator.selectOption({ label: chosen }).catch(() => {});
  await pause(page, 140, 380);
  return true;
}

async function applyRadio(page, field, value) {
  const want = norm(value);
  // Every radio/toggle member of the group is present in the DOM (unlike an
  // async combobox, whose list only exists after typing), so the scanned
  // members ARE the full list - no live re-read needed here.
  const target = field.members.find((mm) => norm(mm.optionLabel) === want)
    || field.members.find((mm) => norm(mm.optionLabel).includes(want) || want.includes(norm(mm.optionLabel)));
  if (!target) return false;
  // Idempotent: skip when this option is already active. Ashby Yes/No members
  // are toggle <button>s, so re-clicking an already-pressed one deselects it and
  // a later pass re-selects it — the "deselect then select" loop the CA sees.
  const on = await target.locator.evaluate((el) => el.checked === true
    || el.getAttribute('aria-pressed') === 'true'
    || el.getAttribute('aria-checked') === 'true'
    || el.getAttribute('data-state') === 'checked').catch(() => false);
  if (on) return true;
  // Ashby Yes/No members are <button>s (real, clickable); native radios are
  // often visually hidden, so fall back to force click/check if the gesture fails.
  await target.locator.scrollIntoViewIfNeeded().catch(() => {});
  await moveToLocator(page, target.locator).catch(() => {});
  await pause(page, 70, 200);
  let done = false;
  try { await target.locator.click({ timeout: 900 }); done = true; }
  catch { /* hidden/covered -> force path below */ }
  if (!done) {
    try { await target.locator.check({ force: true }); }
    catch { await target.locator.click({ force: true }).catch(() => {}); }
  }
  await pause(page, 150, 400);
  return true;
}

async function applyCheckbox(page, locator, value) {
  const yes = /^(y|yes|true|1|on|agree|accept|opt in|opt-in)/i.test(String(value).trim());
  await moveToLocator(page, locator).catch(() => {}); // move the cursor onto the box first
  await pause(page, 60, 180);
  if (yes) await locator.check({ force: true }).catch(() => {});
  else await locator.uncheck({ force: true }).catch(() => {});
  await pause(page, 130, 340);
  return true;
}

// Ashby-style type-ahead: focus, type, wait for the suggestion popup, click
// the best-matching option. Falls back to the first suggestion, then Enter.
async function applyCombobox(page, field, value) {
  const text = String(value).trim();
  if (!text) return false;

  const innerInput = field.locator.locator('input').first();
  const hasInner = await innerInput.count().catch(() => 0);
  const typingTarget = hasInner ? innerInput : field.locator;

  try { await humanClick(page, field.locator); }
  catch { await field.locator.focus().catch(() => {}); }

  await typingTarget.fill('').catch(() => {});
  const typed = await humanType(page, typingTarget, text).catch(() => false);
  if (!typed) {
    const seq = await typingTarget.pressSequentially
      ? typingTarget.pressSequentially(text, { delay: 55 }).then(() => true).catch(() => false)
      : false;
    if (!seq) await typingTarget.fill(text).catch(() => {});
  }

  await page.waitForTimeout(1200); // let the async suggestions arrive

  const optionLoc = page.locator(
    '[role="option"]:visible, [role="listbox"] li:visible, ul[role="listbox"] *:visible, .ashby-combobox__option:visible'
  );
  const count = await optionLoc.count().catch(() => 0);
  const want = norm(text);
  for (let k = 0; k < count; k += 1) {
    const t = norm(await optionLoc.nth(k).textContent().catch(() => ''));
    if (t && (t === want || t.includes(want) || want.includes(t))) {
      await humanClick(page, optionLoc.nth(k)).catch(() => {});
      await page.waitForTimeout(300);
      return true;
    }
  }
  // No suggestion matched the requested value. Do NOT blindly click the first
  // option: for a CA-approved value the picker can't resolve (e.g. "N/A" typed
  // into a location box) that silently substitutes data the CA never chose —
  // exactly the "N/A became Dallas" surprise. Close the popup and report the
  // miss so the field stays unfilled and is re-surfaced to the CA instead.
  await page.keyboard.press('Escape').catch(() => {});
  return false;
}

/* ----------------------------- dispatch ----------------------------- */

export async function applyFieldValue(page, field, value) {
  if (value === null || value === undefined || String(value).trim() === '') return false;
  let ok = false;
  switch (field.kind) {
    case 'text':
    case 'textarea':
      await applyText(page, field.locator, value); ok = true; break;
    case 'select':
      ok = await applySelect(page, field, value); break;
    case 'radio':
      ok = await applyRadio(page, field, value); break;
    case 'checkbox':
      ok = await applyCheckbox(page, field.locator, value); break;
    case 'combobox':
      ok = await applyCombobox(page, field, value); break;
    default:
      ok = false;
  }
  if (ok) await pause(page, 180, 520); // brief glance between fields
  return ok;
}

/* ------------------------- pre-automation scan ---------------------- */

// Serializable inventory of every field the applier could interact with: the
// question text, the control kind, and its available options. Used by the
// scan pass to cache a job link's form schema (question + type) locally.
// Derive the human-facing question for a collected control. Radios carry it in
// the climbed ancestor text (with Ashby's option/name/id junk baked in); every
// other control has a real <label>. Shared by the scan and the answer-replay
// pass so both compute the SAME key for the SAME control.
export function deriveFieldQuestion(f) {
  const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // A caption found next to the control is authoritative: it is literally what
  // the form asks, so the CA pane, the stored answer key and the replay all use
  // it verbatim. Only when there is none do we fall back to the (mangled) label
  // blob / placeholder chain that earlier builds relied on.
  const caption = String((f.kind === 'radio' ? (f.legendText || f.nearQuestion) : f.nearQuestion) || '').trim();
  const placeholderish = /^(start typing|type to search|search\.\.\.|select\.\.\.|choose\.\.\.|enter\.\.\.|n\/?a)[\s.]*$/i;
  if (caption && !placeholderish.test(caption)) return caption;
  let question = f.kind === 'radio'
    ? (f.questionText || f.labelText || f.placeholder || f.name || f.id || '')
    : (f.labelText || f.questionText || f.placeholder || f.name || f.id || '');
  question = String(question).replace(/\s+/g, ' ').trim();
  if (f.kind === 'radio') {
    // Ashby concatenates the option labels (and the control's own name/id,
    // e.g. "GenderInput") into the radio group's ancestor text. Strip every
    // option string wherever it appears, then drop the leaked name/id tokens,
    // so the CA sees the real question ("Gender"), not the mangled blob.
    let changed = true;
    while (changed) {
      changed = false;
      for (const o of (f.options || [])) {
        const re = new RegExp('(^|\\s)' + esc(o) + '(\\s|$)', 'ig');
        if (re.test(question)) { question = question.replace(re, ' ').trim(); changed = true; }
      }
    }
    for (const junk of [f.name, f.id]) {
      const j = String(junk || '').trim();
      if (j && j.length > 1) question = question.replace(new RegExp(esc(j), 'ig'), ' ').trim();
    }
    question = question.replace(/[\s]*[-?:]\s*$/, '').replace(/\s+/g, ' ').trim();
  }
  return question || caption;
}

// Must match store.js fieldKeyOf exactly so a live control and its cached scan
// row (and therefore its confirmed answer) collapse to the same key.
export function fieldKeyOf(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 200);
}

export async function scanFields(page) {
  const fields = await collectFields(page);
  return fields
    .map((f) => ({
      kind: f.kind,
      question: deriveFieldQuestion(f).slice(0, 1500),
      name: f.name || '',
      id: f.id || '',
      placeholder: (f.placeholder || '').trim(),
      type: f.type || '',
      options: Array.isArray(f.options) ? f.options.map((o) => String(o).replace(/\s+/g, ' ').trim()).filter(Boolean) : [],
      // null = the form never marked it, so the gate keeps treating it as
      // required instead of silently unlocking the question.
      required: f.required === true ? true : (f.required === false ? false : null),
      answered: !!f.answered
    }))
    .filter((f) => f.question || f.name || f.id || f.placeholder);
}

/* ------------------------- answer replay (submit) ------------------- */

// Replay the confirmed pre-Apply answers (draft + CA review) onto the live
// form. Each stored answer is matched to a visible control by recomputing the
// SAME field key the scan used, so the exact question the CA reviewed gets the
// exact value they confirmed. This is authoritative: it overwrites whatever the
// live resume matcher guessed (e.g. a bogus "0" graduation year, or a blank
// radio the CA actually answered). Returns { applied, total }.
export async function applyConfirmedAnswers(page, answers = []) {
  const usable = (Array.isArray(answers) ? answers : [])
    .filter((a) => a && a.value != null && String(a.value).trim() !== '');
  if (!usable.length) return { applied: 0, total: 0 };

  const fields = await collectFields(page);
  const byKey = new Map();
  for (const a of usable) {
    const fromQ = fieldKeyOf(a.question_text || a.question || '');
    const fromK = fieldKeyOf(a.field_key || '');
    if (fromQ) byKey.set(fromQ, a);
    if (fromK) byKey.set(fromK, a);
  }

  let applied = 0;
  for (const f of fields) {
    const k = fieldKeyOf(deriveFieldQuestion(f)) || fieldKeyOf(f.name) || fieldKeyOf(f.id) || fieldKeyOf(f.placeholder);
    if (!k) continue;
    const a = byKey.get(k) || byKey.get(String(k).replace(/_+$/, ''));
    if (!a) continue;
    // Avoid redundant re-typing when the live text already matches exactly.
    if ((f.kind === 'text' || f.kind === 'textarea') && norm(f.value) === norm(a.value)) continue;
    const ok = await applyFieldValue(page, f, a.value);
    if (ok) applied += 1;
  }
  return { applied, total: usable.length };
}
