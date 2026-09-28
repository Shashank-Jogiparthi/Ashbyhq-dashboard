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

// Text that betrays a page which is not an application form. Anchored on the
// words a listing/404 page actually renders, not on generic prose.
export const NOT_FORM_RE = /page not found|not found|404|no longer exists|doesn'?t exist|expired|invalid link|open roles|open positions|all roles|current openings|latest jobs|browse (?:all )?(?:jobs|roles)|coming soon/i;

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

  if (!fields.length) return { ok: false, why: 'the page exposed no application-form fields at all' };
  if (seen && NOT_FORM_RE.test(seen)) {
    return { ok: false, why: `not an application form — the page read "${seen.slice(0, 120)}"` };
  }
  // A real form always asks for more than one thing. One control on a URL that is
  // not an explicit /application page means the click-through never happened.
  if (inventoryIsResidue(fields, link)) {
    const q = String(fields[0]?.question || fields[0]?.field_key || 'unnamed control');
    return { ok: false, why: `only 1 field ("${q.slice(0, 80)}") on a URL that is not an /application form — this looks like a job listing, not an application` };
  }
  return { ok: true };
}
