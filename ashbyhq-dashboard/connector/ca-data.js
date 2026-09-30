/* =====================================================================
   ca_data builder (v3.7 CA work-history).

   Builds the AWL-ID -> CA -> OM(CAM) index (`ca_data`) purely from the CRM's
   permitted table clients_additional_info (career_associate_id /
   career_associate_manager_id), matched onto the roster's `staff` rows by
   ext_id. The email that keys the external work-history API is resolved from
   the roster FIRST (staff.ext_id -> staff.email); when the CRM names a CA uuid
   that has NO roster row, we fall back to the external /api/ca/emails id->email
   bridge and store the email while leaving ca_id NULL — we NEVER invent a
   person, we just record that the id maps to a known email.

   Side effect (guarded): when not a dry-run the builder also performs a
   VISIBILITY-ONLY assignment — it points each resolved applicant at its real
   CA/OM via upsertExternalApplicant({ materialize:false }) so every CA can see
   their whole book, but it stores the job links PENDING and creates NO
   applications and NO scan backlog. That is the anti-flood contract the
   verify:flow rule asserts.

   Every data source is injectable (readInfoRows, caEmailsImpl) so verify:flow
   drives the exact same logic against fixtures with no live CRM and no network.
   ===================================================================== */
import {
  upsertCaData, upsertExternalApplicant, getStaff, logEvent
} from '../db/store.js';
import { seedStaffDirectory, resolveTree } from './staff-directory.js';
import { caEmails } from './external-apis.js';
import { normalizeAwlId } from './applicant-db.js';
import { getPg, pgConfig } from './azure-config.js';

const INFO_TABLE = () => process.env.PG_APPLICANT_INFO_TABLE || 'public.clients_additional_info';

// Read the AWL -> CA/OM columns straight from the CRM (returns null when this
// host has no Postgres configured, so callers can skip cleanly).
async function readCrmInfoRows() {
  const cfg = pgConfig();
  if (!cfg) return null;
  const pg = await getPg();
  const pool = new pg.Pool(cfg);
  try {
    const { rows } = await pool.query(
      `SELECT applywizz_id, full_name, personal_email, company_email,
              career_associate_id, career_associate_manager_id
         FROM ${INFO_TABLE()}
        WHERE applywizz_id IS NOT NULL`
    );
    return rows;
  } finally {
    await pool.end().catch(() => {});
  }
}

// Resolve the CA/OM email: roster uuid wins (staff.email), else the external
// id->email bridge, else null (the id stays recorded as unresolved provenance).
async function resolveEmail(staffUuid, extId, emailByExt) {
  if (staffUuid) {
    const s = await getStaff(staffUuid);
    if (s?.email) return s.email;
  }
  if (extId) {
    const e = emailByExt.get(String(extId).toLowerCase());
    if (e) return e;
  }
  return null;
}

/**
 * Build/refresh `ca_data` and (when not dry-run) point applicants at their CA/OM
 * for visibility only. Returns counts; never touches the external HTTP work-history.
 */
export async function buildCaData({
  dryRun = false,
  actor = 'system',
  readInfoRows = null,
  caEmailsImpl = caEmails
} = {}) {
  await seedStaffDirectory();

  const rows = readInfoRows ? await readInfoRows() : await readCrmInfoRows();
  if (!rows) {
    return { skipped: 'no_postgres', awls: 0, caDataWritten: 0, applicantsCreated: 0, applicantsPointed: 0, unresolvedCa: 0, unresolvedOm: 0 };
  }

  // External id->email bridge (authoritative for un-rostered CA uuids). Optional:
  // if unset or it errors we simply resolve fewer emails — never a hard failure.
  const emailByExt = new Map();
  try {
    const ce = await caEmailsImpl();
    if (ce?.ok && Array.isArray(ce.users)) {
      for (const u of ce.users) {
        if (u?.id && u?.email) emailByExt.set(String(u.id).toLowerCase(), String(u.email).toLowerCase());
      }
    }
  } catch { /* bridge is best-effort; roster remains primary */ }

  let awls = 0;
  let caDataWritten = 0;
  let applicantsCreated = 0;
  let applicantsPointed = 0;
  let unresolvedCa = 0;
  let unresolvedOm = 0;

  for (const row of rows) {
    const awl = normalizeAwlId(row.applywizz_id || row.applywizzId);
    if (!awl) continue;
    awls += 1;
    // resolveTree also opportunistically writes the CA->OM staff edge.
    const tree = await resolveTree(row);
    const caEmail = await resolveEmail(tree.caId, tree.caExtId, emailByExt);
    const omEmail = await resolveEmail(tree.opsId, tree.omExtId, emailByExt);
    if (tree.caExtId && !tree.caId) unresolvedCa += 1;
    if (tree.omExtId && !tree.opsId) unresolvedOm += 1;

    if (!dryRun) {
      await upsertCaData({
        awlId: awl, caId: tree.caId, caEmail, caExtId: tree.caExtId,
        omId: tree.opsId, omEmail, omExtId: tree.omExtId
      });
      caDataWritten += 1;

      // Visibility-only assignment: only when we resolved a real CA/OM staff row.
      if (tree.caId || tree.opsId) {
        const res = await upsertExternalApplicant({
          awlId: awl,
          fullName: row.full_name || awl,
          email: row.personal_email || row.company_email || '',
          caId: tree.caId,
          opsId: tree.opsId,
          materialize: false
        });
        if (res.created) applicantsCreated += 1; else applicantsPointed += 1;
      }
    }
  }

  const result = dryRun
    ? { dryRun: true, wouldWrite: awls, awls, unresolvedCa, unresolvedOm }
    : { awls, caDataWritten, applicantsCreated, applicantsPointed, unresolvedCa, unresolvedOm };

  await logEvent(null, 'ca_data_built', actor, { ...result, dryRun: Boolean(dryRun) });
  return result;
}

// Re-export the DEV-pane snapshot helper so routes import from one place.
export { caDataStats } from '../db/store.js';
