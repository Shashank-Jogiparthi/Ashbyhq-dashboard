/* =====================================================================
 ASHBY JOB-LINK QUESTION CACHE  (external Azure CRM Postgres)

 public.ashby_joblink_questions — exactly three columns:

   job_id     TEXT     PRIMARY KEY   -- stable Ashby posting identity
   job_link   TEXT     NOT NULL UNIQUE -- the full application URL
   questions  JSONB    NOT NULL DEFAULT '[]'  -- pre-scanned question inventory

 WHY this table exists
 ---------------------
 A job link never changes, but the number of applicants (AWL-IDs) attached to
 it does. So the expensive part — opening the form and scanning every question,
 its control type and its options — is captured ONCE per link here and reused
 for every applicant that link is assigned to. The user maintains the
 (AWL-ID -> job link) pairs themselves, so a link is registered here the moment
 it is ingested (questions = '[]') and filled in by the pre-scan.

 The (AWL-ID -> job link) pairs themselves are assigned in the companion table
 public.ashby_joblinks (see connector/awl-links.js). public.client_legacy is not
 read anywhere in this codebase.

 Every function degrades quietly when the CRM is not configured/reachable, so
 the dashboard keeps working on local SQLite alone.
 ===================================================================== */
import { getPg, pgConfig } from './azure-config.js';
import { canonicalJobUrl, jobIdFromUrl as canonicalJobId, POSTING_UUID_RE } from '../core/job-url.js';

const TABLE = () => process.env.PG_QUESTIONS_TABLE || 'public.ashby_joblink_questions';

export function questionsConfigured() {
  return Boolean(pgConfig());
}

function splitTable() {
  const t = TABLE();
  return t.includes('.') ? t.split('.') : ['public', t];
}

/**
 * Stable identity of an Ashby posting — the trailing posting UUID, so every
 * tracking/source variant of the same job collapses to one row (see
 * core/job-url.js for the full rule and its deliberate limits).
 */
export function jobIdFromUrl(url) {
  return canonicalJobId(url);
}

/** The canonical form of a link we store: no fragment, no tracking query. */
export function normalizeJobLink(url) {
  return canonicalJobUrl(url);
}

// pg hands JSONB back as an object; a hand-edited cell or a TEXT column would
// be a string. Normalise to a real array so callers never have to care.
function asArray(v) {
  if (Array.isArray(v)) return v;
  if (v === null || v === undefined || v === '') return [];
  if (typeof v === 'string') {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : [p]; } catch { return []; }
  }
  return [v];
}

/* ------------------------------------------------------------------ */
/* SCHEMA                                                              */
/* ------------------------------------------------------------------ */

// Creates the 3-column table when it is absent. NEVER alters an existing
// table's shape — that is scripts/setup-joblink-questions.js (explicit, reviews
// the columns it would drop). Safe to call on every boot.
export async function ensureQuestionsTable() {
  const cfg = pgConfig();
  if (!cfg) return { ok: false, skipped: 'crm_not_configured' };
  const pg = await getPg();
  const [schema, name] = splitTable();
  const pool = new pg.Pool(cfg);
  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}";
      CREATE TABLE IF NOT EXISTS "${schema}"."${name}" (
        job_id    TEXT PRIMARY KEY,
        job_link  TEXT NOT NULL UNIQUE,
        questions JSONB NOT NULL DEFAULT '[]'::jsonb
      );`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  } finally {
    await pool.end();
  }
}

/* ------------------------------------------------------------------ */
/* READ / WRITE                                                        */
/* ------------------------------------------------------------------ */

/**
 * Register a link (idempotent) and/or store its scanned questions.
 * Pass questions = undefined to register without touching existing questions.
 */
export async function upsertJobLinkQuestions({ url, jobLink = null, questions } = {}) {
  const cfg = pgConfig();
  const link = normalizeJobLink(jobLink || url);
  const jobId = jobIdFromUrl(link);
  if (!cfg) return { ok: false, skipped: 'crm_not_configured', jobId, link };
  if (!jobId || !link) return { ok: false, skipped: 'no_job_id', jobId, link };
  const pg = await getPg();
  const [schema, name] = splitTable();
  const q = `"${schema}"."${name}"`;
  const pool = new pg.Pool(cfg);
  try {
    const payload = questions === undefined ? null : JSON.stringify(asArray(questions));
    await pool.query('BEGIN');
    // A different job_id that already owns this exact URL is stale (e.g. the
    // link was previously stored under a fallback id) — remove it so the UNIQUE
    // constraint on job_link cannot reject the write.
    await pool.query(`DELETE FROM ${q} WHERE job_link = $1 AND job_id <> $2`, [link, jobId]);
    if (payload === null) {
      await pool.query(
        `INSERT INTO ${q} (job_id, job_link, questions) VALUES ($1, $2, '[]'::jsonb)
         ON CONFLICT (job_id) DO NOTHING`, [jobId, link]);
    } else {
      await pool.query(
        `INSERT INTO ${q} (job_id, job_link, questions) VALUES ($1, $2, $3::jsonb)
         ON CONFLICT (job_id) DO UPDATE SET
           job_link = excluded.job_link,
           questions = excluded.questions`, [jobId, link, payload]);
    }
    await pool.query('COMMIT');
    const row = await pool.query(`SELECT questions FROM ${q} WHERE job_id = $1`, [jobId]);
    return { ok: true, jobId, link, count: asArray(row.rows[0]?.questions).length };
  } catch (err) {
    await pool.query('ROLLBACK').catch(() => {});
    return { ok: false, error: String(err.message || err), jobId, link };
  } finally {
    await pool.end();
  }
}

/** Fetch one cached link row by job_id or by any variant of its URL. */
export async function fetchJobLinkQuestions(idOrUrl) {
  const cfg = pgConfig();
  if (!cfg) return null;
  const needle = String(idOrUrl || '').trim();
  if (!needle) return null;
  const jobId = POSTING_UUID_RE.test(needle) ? needle.toLowerCase() : jobIdFromUrl(needle);
  const link = normalizeJobLink(needle);
  const pg = await getPg();
  const [schema, name] = splitTable();
  const pool = new pg.Pool(cfg);
  try {
    const { rows } = await pool.query(
      `SELECT job_id, job_link, questions FROM "${schema}"."${name}"
        WHERE job_id = $1 OR job_link = $2 OR job_link = $3 LIMIT 1`,
      [jobId, link, needle]
    );
    const r = rows[0];
    if (!r) return null;
    return { job_id: r.job_id, job_link: r.job_link, questions: asArray(r.questions) };
  } catch {
    return null;                                   // missing table/columns -> cache miss
  } finally {
    await pool.end();
  }
}

/** All registered links with how many questions each one has cached. */
export async function listJobLinkQuestions() {
  const cfg = pgConfig();
  if (!cfg) return { ok: false, skipped: 'crm_not_configured', rows: [] };
  const pg = await getPg();
  const [schema, name] = splitTable();
  const pool = new pg.Pool(cfg);
  try {
    const { rows } = await pool.query(
      `SELECT job_id, job_link, jsonb_array_length(CASE WHEN jsonb_typeof(questions) = 'array'
                THEN questions ELSE '[]'::jsonb END) AS question_count
         FROM "${schema}"."${name}" ORDER BY job_id`
    );
    return { ok: true, rows: rows.map((r) => ({ ...r, question_count: Number(r.question_count) })) };
  } catch (err) {
    return { ok: false, error: String(err.message || err), rows: [] };
  } finally {
    await pool.end();
  }
}
