/* =====================================================================
   Job-link identity helpers (shared by the local store and the CRM
   connectors, so a link is keyed the SAME way everywhere).

   WHY this exists
   ---------------
   The same Ashby posting arrives in several spellings:

     https://jobs.ashbyhq.com/Deepgram/9a030b32-...?source=rLVNdemx1O
     https://jobs.ashbyhq.com/Deepgram/9a030b32-...?src=Linkedin
     https://jobs.ashbyhq.com/Deepgram/9a030b32-...

   All three are ONE posting (the UUID in the path is the posting id), so they
   must collapse to ONE job_links row -> ONE pre-scan -> ONE set of questions
   reused by every applicant. Without this, each tracking variant gets its own
   row and the next sync silently creates a duplicate application.

   The collapse is deliberately NARROW: the query string is only dropped when
   the path already carries a posting UUID (or the host is a jobs.ashbyhq.com
   posting). Links that put their identity IN the query — e.g.
   https://www.provenir.com/careers/?ashby_jid=220ab6c7-... — are left exactly
   as they are, because stripping there would destroy the link.
   ===================================================================== */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export { UUID_RE as POSTING_UUID_RE };

/**
 * Canonical URL used as the identity of a job link everywhere
 * (job_links.url, applicant_joblinks.url, ashby_joblinks.job_links[],
 * ashby_joblink_questions.job_link).
 */
export function canonicalJobUrl(url) {
  const raw = String(url || '').trim();
  if (!raw) return '';
  let u;
  try {
    u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    return raw;
  }
  const segs = u.pathname.split('/').filter(Boolean);
  const hasPostingId = segs.some((s) => UUID_RE.test(s));
  if (!hasPostingId) return raw;          // identity lives in the query -> keep it
  // Ashby posting ids are case-insensitive; lower-case them so a hand-typed
  // uppercase variant cannot create a second row for the same job.
  u.pathname = `/${segs.map((s) => (UUID_RE.test(s) ? s.toLowerCase() : s)).join('/')}`;
  u.hash = '';
  u.search = '';                          // tracking params are noise for a UUID posting
  return u.toString().replace(/\/+$/, '');
}

/**
 * Stable job_id for a link: the posting UUID when present (so every spelling of
 * one posting shares one id), else host+path of the canonical URL.
 */
export function jobIdFromUrl(url) {
  const raw = canonicalJobUrl(url);
  if (!raw) return '';
  let u;
  try {
    u = new URL(raw.startsWith('http') ? raw : `https://${raw}`);
  } catch {
    return raw.toLowerCase();
  }
  const segs = u.pathname.split('/').filter(Boolean);
  for (const s of segs) if (UUID_RE.test(s)) return s.toLowerCase();
  return `${u.hostname.toLowerCase()}/${segs.join('/').toLowerCase()}`.replace(/\/+$/, '');
}

/**
 * Best-effort company name for a link, so an ingested job card never reads
 * "Unknown". Ashby puts it in the path: jobs.ashbyhq.com/<company>/<uuid>.
 * Returns '' when nothing sensible can be derived (the caller keeps its own
 * default), and never invents a value.
 */
export function companyFromUrl(url) {
  let u;
  try {
    u = new URL(canonicalJobUrl(url) || String(url || ''));
  } catch {
    return '';
  }
  const segs = u.pathname.split('/').filter(Boolean);
  const idx = segs.findIndex((s) => UUID_RE.test(s));
  const slug = idx > 0 ? segs[idx - 1] : (segs.length > 1 ? segs[0] : '');
  if (!slug) return '';
  if (/^(jobs|www|[a-z0-9-]+\.herokappr)\b/i.test(slug)) return '';
  if (/^[a-z0-9_-]+$/i.test(slug) === false) return '';
  // Preserve the CRM's own casing (Deepgram, ProvenirInc); only prettify all-lower.
  return slug === slug.toLowerCase() ? slug.charAt(0).toUpperCase() + slug.slice(1) : slug;
}
