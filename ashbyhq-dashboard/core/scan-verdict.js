/* =====================================================================
   SCAN VERDICT — "is what the browser looked at actually an application form?"

   WHY this lives in its own module
   --------------------------------
   A scan that returns almost nothing used to be treated as a result: it was
   written to job_link_fields and published to the shared
   public.ashby_joblink_questions cache, and because the cache is keyed by link
   and consulted FIRST, that junk then answered every later applicant on every
   install — a CA review pane showing one question ("Email") for a job that asks
   fourteen. Two real incidents produced this rule:

     • a company-careers URL whose job identity sits in the QUERY
       (https://www.example.com/careers/roles?ashby_jid=<uuid>) is a job LISTING;
       the form lives on a different page, so the scan captured the list, and
     • a wrong or expired posting id renders Ashby's "Page not found", which
       loads perfectly and yields the page's own stray input controls.

   Both look like a successful scan to a caller that only checks the exit code.
   So the check is separate, pure, and asserted by scripts/verify-flow.js: it can
   never be skipped by whoever runs the scan.

   The rule deliberately errs toward REFUSING. A refused scan costs one visible
   retry plus one clear last_error a DEV can act on; a stored junk inventory
   costs every future application on that link, silently, everywhere.
   ===================================================================== */

// A CLOSED / REMOVED posting: the link was real, but the job is gone. This is a
// terminal fact about the LINK (not a paste mistake, not a host fault), so it
// gets its own class — the scanner snaps the page as proof and hands it to the
// assigned CA instead of burning retries on a page that will never be a form.
export const POSTING_GONE_RE = /job(?:\s+you\s+requested)?(?:\s+was)?\s+not\s+found|page\s+not\s+found|not\s+found|404|no\s+longer\s+exists|doesn'?t\s+exist|does\s+not\s+exist|no\s+longer\s+accepting|(?:posting|job|position)\s+.{0,18}(?:closed|expired|removed|filled|withdrawn)|has\s+been\s+(?:closed|removed|filled)|archived|unavailable/i;

// A LISTING / wrong page: the URL points at a careers list or a job whose id was
// never an application form. The fix is a different URL, so it is refused with no
// proof and a DEV-facing "replace the link" note.
export const JOB_LISTING_RE = /open\s+(?:roles|positions)|all\s+(?:roles|positions)|current\s+openings|latest\s+jobs|browse\s+(?:all\s+)?(?:jobs|roles)|view\s+all\s+open\s+positions|coming\s+soon/i;

// Kept for callers/tests that only want "is this page clearly not a form?".
export const NOT_FORM_RE = new RegExp(`${POSTING_GONE_RE.source}|${JOB_LISTING_RE.source}`, 'i');

/** An explicit Ashby application-form URL: …/<posting-uuid>/application */
export function isApplicationFormUrl(link) {
  return /\/application\/?$/i.test(String(link || ''));
}

/**
 * A one-field inventory on a URL that is not an explicit form page is residue of
 * a listing page, not a scan result. Used on BOTH sides: refuse to store it, and
 * refuse to trust one that was stored before this rule existed (otherwise the
 * cache lookup would short-circuit forever on the junk it already holds).
 */
export function inventoryIsResidue(rows, link) {
  return Array.isArray(rows) && rows.length === 1 && !isApplicationFormUrl(link);
}

/**
 * judgeScan(scan, link) -> { ok: true } | { ok: false, why: '<sentence>' }
 * `scan` is the engine's FIELD_SCAN_OUT payload ({ posting, fields }); `link` is
 * the canonical job URL that was scanned.
 */
export function judgeScan(scan, link) {
  const fields = Array.isArray(scan?.fields) ? scan.fields : [];
  const p = scan?.posting || {};
  const seen = [p.jobTitle, p.h1, p.docTitle, p.headingAttr]
    .map((s) => String(s || '').trim()).filter(Boolean).join(' · ');

  // A closed posting is checked FIRST, before the empty-fields short-circuit:
  // Ashby's "Job not found" page legitimately exposes zero form fields, and the
  // page's own words are what make it a *gone* link rather than a generic scan
  // that found nothing. The two have different owners and different follow-ups.
  if (seen && POSTING_GONE_RE.test(seen)) {
    return { ok: false, kind: 'posting_gone', why: `the job posting is closed or unavailable — the page read "${seen.slice(0, 120)}"` };
  }
  if (!fields.length) return { ok: false, kind: 'no_fields', why: 'the page exposed no application-form fields at all' };
  if (seen && JOB_LISTING_RE.test(seen)) {
    return { ok: false, kind: 'listing', why: `not an application form — the page read "${seen.slice(0, 120)}"` };
  }
  // A real form always asks for more than one thing. One control on a URL that is
  // not an explicit /application page means the click-through never happened.
  if (inventoryIsResidue(fields, link)) {
    const q = String(fields[0]?.question || fields[0]?.field_key || 'unnamed control');
    return { ok: false, kind: 'residue', why: `only 1 field ("${q.slice(0, 80)}") on a URL that is not an /application form — this looks like a job listing, not an application` };
  }
  return { ok: true, kind: 'form' };
}
