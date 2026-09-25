/* =====================================================================
   External applicant DB connector (Azure PostgreSQL).

   Source of truth is now the two live CRM tables, joined on the AWL-ID
   (`applywizz_id`) — the ONLY key needed to resolve any applicant:
     * public.client_profiles          (62 cols: demographics, work-auth,
                                        education, address, DOB, links, and
                                        the resume download URL / S3 path)
     * public.clients_additional_info  (34 cols: name, emails, phones, role
                                        preferences, salary range, locations,
                                        manager/CA UUIDs)

   We normalise the joined row into the SAME profile shape the automation
   engine already consumes (personal / contact / education / skills /
   experience / answers / raw). Critically we also stash the untouched
   columns under profile.raw.{client, additional_information} so the engine's
   buildRecordMap() + DERIVED_RULES resolve every knock-out deterministically
   from the real column names — no GenAI, no guessing. Only the resume
   ADDRESS (S3 https URL) is kept; the worker downloads it per run and never
   stores the PDF.

   `pg` is imported lazily (getPg) so the server boots fine before the DB is
   reachable. When no Postgres env is present, ingestDocument() still accepts
   a JSON export of the { client, additional_information } shape for testing.

   JOB LINKS come from public.ashby_joblinks (awl_id -> job_links[]) and their
   pre-scanned questions from public.ashby_joblink_questions — see
   connector/awl-links.js and connector/joblink-questions.js.
   public.client_legacy is not read anywhere in this codebase.
   ===================================================================== */
import {
  upsertExternalApplicant,
  upsertApplicantJoblink,
  findStaffByExtId,
  logEvent
} from '../db/store.js';
import { getPg, pgConfig } from './azure-config.js';
import { listAwlJobLinks, ensureAwlLinksTable } from './awl-links.js';
import { upsertJobLinkQuestions, ensureQuestionsTable } from './joblink-questions.js';

const PROFILE_TABLE = () => process.env.PG_APPLICANTS_TABLE || 'public.client_profiles';
const INFO_TABLE = () => process.env.PG_APPLICANT_INFO_TABLE || 'public.clients_additional_info';
// Where a SUCCESSFUL application's finalized answers are written back to the
// CRM (best-effort; the table is auto-created on first write if missing).
const RESULT_TABLE = () => process.env.PG_RESULT_TABLE || 'public.applywizz_applications';

export function isConfigured() {
  return Boolean(pgConfig());
}

/* --------------------- column -> value helpers ---------------------- */

function pick(obj, ...keys) {
  for (const k of keys) {
    const v = obj?.[k];
    if (v !== undefined && v !== null && v !== '') return v;
  }
  return '';
}

// Render a DB cell to a clean scalar for the profile: arrays joined, Dates
// already strings (type parser), objects narrowed to name/title.
function cell(v) {
  if (v === null || v === undefined) return '';
  if (Array.isArray(v)) return v.join(', ').trim();
  if (typeof v === 'object') return String(v.name || v.title || '').trim();
  return String(v).trim();
}

// Canonical applicant key. The CRM already stores "AWL-<digits>"; this makes
// the shape explicit and collapses case / spacing / prefix-less / dashless
// variants (from manual ingest or hand-typed ids) to one key: "AWL-<digits>".
// Anything that is not an AWL+number is returned upper-cased untouched so a
// genuinely different id still surfaces rather than being silently mangled.
export function normalizeAwlId(raw) {
  const s = String(raw ?? '').trim().toUpperCase().replace(/\s+/g, '');
  if (!s) return '';
  const m = s.match(/^AWL-?(\d+)$/);
  return m ? `AWL-${m[1]}` : s;
}

// Booleans stay booleans (so yesNo()/truthiness rules read them), everything
// else is rendered to text. Empty/null -> null so the key is simply absent.
function keep(v) {
  if (typeof v === 'boolean') return v;
  const s = cell(v);
  return s === '' || s.toLowerCase() === 'null' ? null : s;
}

/* --------------- joined Postgres row -> local mapping --------------- */

// prof = a client_profiles row, info = a clients_additional_info row.
// Either may be missing; we merge whatever we have. Keyed by applywizz_id.
export function mapCombined(prof = {}, info = {}) {
  const fullName = cell(pick(info, 'full_name', 'fullName')) || cell(pick(prof, 'full_name'));
  const email = cell(pick(info, 'personal_email', 'company_email'));
  const phone = cell(pick(info, 'callable_phone', 'whatsapp_number')) || cell(pick(prof, 'primary_phone'));
  const awlId = normalizeAwlId(cell(pick(prof, 'applywizz_id')) || cell(pick(info, 'applywizz_id')));
  const extId = cell(pick(info, 'id')) || cell(pick(prof, 'id')) || null;
  // resume_url is a public S3 https link the worker downloads per run; the
  // google-drive link and raw S3 path are lower-precedence fallbacks.
  const resumeAddress =
    cell(pick(prof, 'resume_url')) ||
    cell(pick(prof, 'google_drive_resume_link')) ||
    cell(pick(prof, 'resume_path'));

  const nameParts = String(fullName || '').trim().split(/\s+/).filter(Boolean);

  const profile = {
    personal: {
      name: fullName,
      firstName: cell(pick(prof, 'first_name')) || nameParts[0] || '',
      lastName: cell(pick(prof, 'last_name')) || nameParts.slice(1).join(' ') || '',
      email
    },
    contact: {
      email,
      phone,
      whatsapp: cell(pick(info, 'whatsapp_number')),
      mobile: cell(pick(info, 'callable_phone')) || cell(pick(prof, 'primary_phone')),
      address: cell(pick(prof, 'full_address')),
      city: cell(pick(prof, 'state_of_residence')),
      country: cell(pick(prof, 'zip_or_country')),
      dateOfBirth: cell(pick(prof, 'date_of_birth'))
    },
    education: prof.highest_education ? [cell(prof.highest_education)] : [],
    skills: Array.isArray(info.job_role_preferences)
      ? info.job_role_preferences.map((s) => cell(s)).filter(Boolean)
      : (cell(pick(prof, 'role')) ? [cell(pick(prof, 'role'))] : []),
    projects: [],
    experience: prof.experience != null && cell(prof.experience) !== '' ? [cell(prof.experience)] : [],
    // Mapped answers for the engine's Tier-1 lookups. The raw block below is
    // what actually powers deterministic knock-out resolution, but keeping the
    // convenience shape preserves compatibility with the older doc profile.
    answers: {
      workAuthorization: keep(pick(prof, 'eligible_to_work_in_us', 'authorized_without_visa')),
      sponsorship: keep(pick(prof, 'require_future_sponsorship')),
      locationPreference: keep(pick(info, 'location_preferences')) || keep(pick(prof, 'state_of_residence')),
      rolePreference: Array.isArray(info.job_role_preferences) ? info.job_role_preferences : [],
      over18: keep(pick(prof, 'is_over_18')),
      veteranStatus: keep(pick(prof, 'veteran_status')),
      gender: keep(pick(prof, 'gender')),
      raceEthnicity: keep(pick(prof, 'race_ethnicity')),
      linkedin: keep(pick(prof, 'linked_in_url')),
      github: keep(pick(prof, 'github_url')),
      gpa: keep(pick(prof, 'cumulative_gpa')),
      graduationYear: keep(pick(prof, 'graduation_year')),
      start_date: keep(pick(prof, 'desired_start_date', 'start_date'))
    },
    // The engine's buildRecordMap flattens BOTH of these sections' columns
    // into the lookup map, so every real column name (eligible_to_work_in_us,
    // require_future_sponsorship, veteran_status, university_name,
    // graduation_year, main_subject, ...) becomes resolvable by DERIVED_RULES.
    raw: { client: info, additional_information: prof }
  };

  return { awlId, extId, fullName, email, phone, resumeAddress, profile, links: [] };
}

// Legacy JSON-document shape ({ client, additional_information }) still used by
// ingestDocument() and any stored raw exports. Delegates to mapCombined.
export function mapApplicantDoc(doc = {}) {
  const client = doc.client || doc;
  const info = doc.additional_information || doc.additionalInfo || {};
  const mapped = mapCombined(info, client);
  // Preserve any job links riding inside the doc (the DB stores none).
  const rawLinks = doc.job_links || doc.links || client.job_links || [];
  mapped.links = (Array.isArray(rawLinks) ? rawLinks : [])
    .map((l) => (typeof l === 'string' ? { url: l } : l))
    .filter((l) => l && l.url);
  return mapped;
}

/* ------------------------- Postgres sync ---------------------------- */

async function resolveOpsFromExternal(info) {
  // The CRM column is still literally named career_associate_manager_id; it
  // holds the external staff UUID that maps to our (renamed) OPS manager.
  const extManager = info?.career_associate_manager_id || info?.careerassociatemanagerid;
  if (!extManager) return null;
  return ((await findStaffByExtId(String(extManager)))?.uuid) || null;
}

async function upsertCombined(prof, info, { opsId, summary }) {
  const mapped = mapCombined(prof || {}, info || {});
  if (!mapped.awlId) { if (summary) summary.skipped += 1; return null; }
  const targetOps = opsId || await resolveOpsFromExternal(info || {});
  const res = await upsertExternalApplicant({
    awlId: mapped.awlId, fullName: mapped.fullName, email: mapped.email,
    phone: mapped.phone, resumeAddress: mapped.resumeAddress,
    profileJson: JSON.stringify(mapped.profile), extId: mapped.extId, opsId: targetOps
  });
  if (summary) { if (res.created) summary.created += 1; else summary.updated += 1; }
  for (const link of mapped.links) {
    await upsertApplicantJoblink(mapped.awlId, { url: link.url, company: link.company || '', title: link.title || '' });
    if (summary) summary.links += 1;
  }
  return res;
}

// Pull the two tables (optionally filtered to a single AWL-ID), join in JS on
// applywizz_id, and stream every applicant into the local store.
export async function syncFromPostgres({ opsId = null, awlId = null } = {}) {
  const cfg = pgConfig();
  if (!cfg) throw new Error('Postgres is not configured (set PGHOST / PGUSER / PGPASSWORD / PGDATABASE or PG_CONNECTION_STRING).');
  const pg = await getPg();
  const pool = new pg.Pool(cfg);
  try {
    const awlParam = awlId ? normalizeAwlId(awlId) : '';
    const where = awlParam ? ' WHERE applywizz_id = $1' : '';
    const params = awlParam ? [awlParam] : [];
    const [{ rows: profiles }, { rows: infos }] = await Promise.all([
      pool.query(`SELECT * FROM ${PROFILE_TABLE()}${where}`, params),
      pool.query(`SELECT * FROM ${INFO_TABLE()}${where}`, params)
    ]);

    const infoByAwl = new Map();
    for (const r of infos) { if (r.applywizz_id) infoByAwl.set(normalizeAwlId(r.applywizz_id), r); }

    const summary = { seen: 0, created: 0, updated: 0, links: 0, skipped: 0 };
    const seenAwls = new Set();
    for (const cp of profiles) {
      const awl = cp.applywizz_id ? normalizeAwlId(cp.applywizz_id) : '';
      if (!awl) { summary.skipped += 1; continue; }
      seenAwls.add(awl);
      summary.seen += 1;
      await upsertCombined(cp, infoByAwl.get(awl) || null, { opsId, summary });
    }
    // Applicants that exist only in the info table (no profile row yet).
    for (const ca of infos) {
      const awl = ca.applywizz_id ? normalizeAwlId(ca.applywizz_id) : '';
      if (!awl || seenAwls.has(awl)) continue;
      seenAwls.add(awl);
      summary.seen += 1;
      await upsertCombined(null, ca, { opsId, summary });
    }

    // Job links: public.ashby_joblinks (awl_id -> job_links[]), the table the
    // user maintains. Each URL becomes a pending applicant_joblinks row, and the
    // link itself is registered in the shared question cache so a scan is only
    // ever needed once per link. Optional PG_LINKS_QUERY still works for an
    // operator-owned view. public.client_legacy is never read.
    await ensureAwlLinksTable();
    await ensureQuestionsTable();
    const mapped = await listAwlJobLinks({ awlId: awlParam || null });
    if (mapped.ok) {
      for (const row of mapped.rows) {
        const awl = normalizeAwlId(row.awl_id);
        if (!awl) continue;
        for (const url of row.job_links) {
          await upsertApplicantJoblink(awl, { url, company: '', title: '' });
          await upsertJobLinkQuestions({ url });          // registers, keeps questions
          summary.links += 1;
        }
      }
      summary.link_source = 'ashby_joblinks';
    } else {
      summary.link_source = mapped.error || mapped.skipped || 'unavailable';
    }
    if (process.env.PG_LINKS_QUERY) {
      const { rows: linkRows } = await pool.query(process.env.PG_LINKS_QUERY, awlParam ? [awlParam] : []);
      for (const lr of linkRows) {
        const awl = normalizeAwlId(lr.applywizz_id || lr.awl_id);
        const url = lr.url || lr.job_link;
        if (awl && url) {
          await upsertApplicantJoblink(awl, { url, company: lr.company || '', title: lr.title || '' });
          summary.links += 1;
        }
      }
    }
    await logEvent(null, 'external_sync', 'connector', { ...summary, awl_id: awlId || 'all' });
    return summary;
  } finally {
    await pool.end();
  }
}

// On-demand: refresh (or create) a single applicant by AWL-ID straight from
// the CRM tables. This is the "everything is known by AWL-ID" entry point.
export async function syncApplicantByAwl(awlId, { opsId = null } = {}) {
  if (!awlId) throw new Error('AWL-ID required');
  return syncFromPostgres({ opsId, awlId });
}

/* --------------------- manual JSON ingest mode ---------------------- */

// Load one exported applicant document (the exact shape you shared) with no
// live DB. Returns the same summary object shape as syncFromPostgres.
export async function ingestDocument(doc, { opsId = null } = {}) {
  const mapped = mapApplicantDoc(doc);
  if (!mapped.awlId) throw new Error('Document has no applywizz_id (AWL-ID)');
  const res = await upsertExternalApplicant({
    awlId: mapped.awlId, fullName: mapped.fullName, email: mapped.email,
    phone: mapped.phone, resumeAddress: mapped.resumeAddress,
    profileJson: JSON.stringify(mapped.profile), extId: mapped.extId, opsId
  });
  for (const link of mapped.links) {
    await upsertApplicantJoblink(mapped.awlId, { url: link.url, company: link.company || '', title: link.title || '' });
  }
  await logEvent(null, 'external_ingest', 'connector', { awl_id: mapped.awlId, links: mapped.links.length });
  return { seen: 1, created: res.created ? 1 : 0, updated: res.created ? 0 : 1, links: mapped.links.length, skipped: 0 };
}

/* -------------------- write-back on SUCCESS ------------------------- */

// When an application SUCCEEDS (never on a missing-field failure), we push the
// finalized submission back into the CRM as a durable record. Supabase remains
// the source of truth for run state; this mirrors the *applied* details only.
// Best-effort: the table is auto-created if absent and every error is swallowed
// into the return value so a write-back hiccup can never fail a run. Set
// PG_WRITEBACK=false to disable entirely.
export async function persistFinalizedToExternal({
  awlId, url, company = '', title = '', status = 'SUCCESS',
  profile = null, answers = [], resumeAddress = ''
} = {}) {
  if (process.env.PG_WRITEBACK === 'false') return { ok: false, skipped: 'disabled' };
  const cfg = pgConfig();
  if (!cfg) return { ok: false, skipped: 'no_postgres' };
  if (!awlId || !url) return { ok: false, skipped: 'missing_key' };
  const table = RESULT_TABLE();
  const [schema, name] = table.includes('.') ? table.split('.') : ['public', table];
  const pg = await getPg();
  const pool = new pg.Pool(cfg);
  try {
    await pool.query(`CREATE TABLE IF NOT EXISTS ${schema}.${name} (
      awl_id text NOT NULL,
      job_url text NOT NULL,
      company text, title text,
      status text, applied_at timestamptz,
      profile_json jsonb, answers_json jsonb,
      resume_address text,
      PRIMARY KEY (awl_id, job_url)
    )`);
    await pool.query(
      `INSERT INTO ${schema}.${name}
        (awl_id, job_url, company, title, status, applied_at, profile_json, answers_json, resume_address)
       VALUES ($1,$2,$3,$4,$5, now(), $6::jsonb, $7::jsonb, $8)
       ON CONFLICT (awl_id, job_url) DO UPDATE SET
         company = EXCLUDED.company, title = EXCLUDED.title, status = EXCLUDED.status,
         applied_at = now(), profile_json = EXCLUDED.profile_json,
         answers_json = EXCLUDED.answers_json, resume_address = EXCLUDED.resume_address`,
      [
        awlId, url, company, title, status,
        JSON.stringify(profile ?? {}),
        JSON.stringify(Array.isArray(answers) ? answers : []),
        resumeAddress || ''
      ]
    );
    return { ok: true, table };
  } catch (err) {
    return { ok: false, error: err.message };
  } finally {
    await pool.end().catch(() => {});
  }
}
