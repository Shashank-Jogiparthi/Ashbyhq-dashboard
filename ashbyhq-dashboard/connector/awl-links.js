/* =====================================================================
 ASHBY APPLICANT -> JOB-LINK MAP   (external Azure CRM Postgres)

 public.ashby_joblinks — exactly two columns:

   awl_id     TEXT   PRIMARY KEY  -- the applicant's AWL-ID (e.g. AWL-101)
   job_links  JSONB  NOT NULL DEFAULT '[]'  -- the links that applicant must apply to

 This is where the (applicant -> job link) assignments come from now: the user
 maintains it, the platform reads it on every sync, and the dashboard's paste box
 writes to it. It replaces the old public.client_legacy reader, which is
 permanently out of use.

 Link identity + pre-scanned questions live in the companion table
 public.ashby_joblink_questions (see connector/joblink-questions.js): one row per
 unique link, reused by however many applicants point at it.

 Every function degrades quietly when the CRM is not configured/reachable.
 ===================================================================== */
import { getPg, pgConfig } from './azure-config.js';
import { normalizeJobLink } from './joblink-questions.js';

const TABLE = () => process.env.PG_AWL_LINKS_TABLE || 'public.ashby_joblinks';

function splitTable() {
  const t = TABLE();
  return t.includes('.') ? t.split('.') : ['public', t];
}

export function awlLinksConfigured() {
  return Boolean(pgConfig());
}

function asLinkArray(v) {
  if (Array.isArray(v)) return v.map((x) => String(x).trim()).filter(Boolean);
  if (typeof v === 'string') {
    const s = v.trim();
    if (!s) return [];
    try { return asLinkArray(JSON.parse(s)); } catch { return [s]; }   // JSON or a bare URL
  }
  return [];
}

/** Creates the 2-column table when absent (never reshapes an existing one). */
export async function ensureAwlLinksTable() {
  const cfg = pgConfig();
  if (!cfg) return { ok: false, skipped: 'crm_not_configured' };
  const pg = await getPg();
  const [schema, name] = splitTable();
  const pool = new pg.Pool(cfg);
  try {
    await pool.query(`CREATE SCHEMA IF NOT EXISTS "${schema}";
      CREATE TABLE IF NOT EXISTS "${schema}"."${name}" (
        awl_id    TEXT PRIMARY KEY,
        job_links JSONB NOT NULL DEFAULT '[]'::jsonb
      );`);
    return { ok: true };
  } catch (err) {
    return { ok: false, error: String(err.message || err) };
  } finally {
    await pool.end();
  }
}

/** Every (AWL-ID -> [links]) row, links normalised to an array of URLs. */
export async function listAwlJobLinks({ awlId = null } = {}) {
  const cfg = pgConfig();
  if (!cfg) return { ok: false, skipped: 'crm_not_configured', rows: [] };
  const pg = await getPg();
  const [schema, name] = splitTable();
  const pool = new pg.Pool(cfg);
  try {
    const { rows } = await pool.query(
      `SELECT awl_id, job_links FROM "${schema}"."${name}"${awlId ? ' WHERE awl_id = $1' : ''} ORDER BY awl_id`,
      awlId ? [awlId] : []
    );
    return { ok: true, rows: rows.map((r) => ({ awl_id: r.awl_id, job_links: asLinkArray(r.job_links) })) };
  } catch (err) {
    return { ok: false, error: String(err.message || err), rows: [] };
  } finally {
    await pool.end();
  }
}

/** Add one link for one applicant, keeping the array free of duplicates. */
export async function appendJobLink(awlId, url) {
  const cfg = pgConfig();
  const link = normalizeJobLink(url);
  if (!cfg) return { ok: false, skipped: 'crm_not_configured' };
  if (!awlId || !link) return { ok: false, skipped: 'no_awl_id_or_link' };
  const pg = await getPg();
  const [schema, name] = splitTable();
  const q = `"${schema}"."${name}"`;
  const pool = new pg.Pool(cfg);
  try {
    await pool.query('BEGIN');
    await pool.query(`INSERT INTO ${q} (awl_id, job_links) VALUES ($1, '[]'::jsonb) ON CONFLICT (awl_id) DO NOTHING`, [awlId]);
    const cur = await pool.query(`SELECT job_links FROM ${q} WHERE awl_id = $1 FOR UPDATE`, [awlId]);
    const links = asLinkArray(cur.rows[0]?.job_links);
    const added = !links.includes(link);
    if (added) {
      links.push(link);
      await pool.query(`UPDATE ${q} SET job_links = $2::jsonb WHERE awl_id = $1`, [awlId, JSON.stringify(links)]);
    }
    await pool.query('COMMIT');
    return { ok: true, awlId, added, count: links.length };
  } catch (err) {
    await pool.query('ROLLBACK').catch(() => {});
    return { ok: false, error: String(err.message || err) };
  } finally {
    await pool.end();
  }
}
