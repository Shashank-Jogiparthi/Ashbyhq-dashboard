/* =====================================================================
   Staff directory — turns the committed roster into real `staff` rows and
   wires the AWL-ID -> CA -> OM(CAM) tree using ONLY the permitted CRM table
   (clients_additional_info) for the reporting edges.

   Two responsibilities, kept separate so each is idempotent:

     1. seedStaffDirectory()  - upsert the 59 CAs + 2 OPS + 2 ADMIN from
        connector/staff-roster.js (identity: uuid -> name/email/role), and
        retire the five legacy @applywizz.local fixtures. Keyed on ext_id
        (CRM uuid) with an email fallback, so re-running NEVER duplicates.

     2. resolveTree(infoRow) / linkCaManagers(rows) - the CA->OM edge and the
        applicant's ca_id/ops_id come from career_associate_id /
        career_associate_manager_id on clients_additional_info (a permitted
        table). We never invent a reporting line; we read it.

   Nothing here opens a Postgres pool: the caller (applicant-db.js) already
   holds one and passes the CRM rows in, so the directory layer stays pure
   against the platform DB and is trivially testable in verify:flow.
   ===================================================================== */
import { db, nowIso, uuid } from '../db/index.js';
import { findStaffByExtId, logEvent } from '../db/store.js';
import {
  CA_ROSTER, MANAGER_ROSTER, ADMIN_ROSTER, FIXTURES_TO_RETIRE
} from './staff-roster.js';

const norm = (e) => String(e || '').toLowerCase().trim();

// CRM column readers tolerate both snake_case and the squashed variant the
// export sometimes uses (careerassociateid).
const caExtOf = (info) => String(info?.career_associate_id || info?.careerassociateid || '').trim();
const omExtOf = (info) => String(info?.career_associate_manager_id || info?.careerassociatemanagerid || '').trim();

// Insert-or-update one staff row by ext_id, then by email. Never touches
// manager_id (that is the CRM-derived edge), last_sign_in, or applicant_quota.
async function upsertByExt({ extId, name, email, role }) {
  const em = norm(email);
  let row = extId ? await db.prepare('SELECT * FROM staff WHERE ext_id = ?').get(extId) : null;
  if (!row && em) row = await db.prepare('SELECT * FROM staff WHERE lower(email) = ?').get(em);
  if (row) {
    await db.prepare('UPDATE staff SET name = ?, email = ?, role = ?, ext_id = ?, active = 1 WHERE uuid = ?')
      .run(name, em, role, extId ?? row.ext_id, row.uuid);
    return { uuid: row.uuid, created: false };
  }
  const u = uuid();
  await db.prepare(`INSERT INTO staff
      (uuid, email, name, role, manager_id, applicant_quota, ext_id, active, last_sign_in, created_at)
      VALUES (?, ?, ?, ?, NULL, 25, ?, 1, NULL, ?)`)
    .run(u, em, name, role, extId ?? null, nowIso());
  return { uuid: u, created: true };
}

// Idempotent: safe to run on every boot and on every full sync.
export async function seedStaffDirectory({ retireFixtures = true } = {}) {
  const s = { ca: 0, ops: 0, admin: 0, created: 0, updated: 0, retired: 0 };
  const tally = (r) => { r.created ? s.created++ : s.updated++; return r; };
  for (const m of MANAGER_ROSTER) { tally(await upsertByExt({ ...m, role: 'ops' })); s.ops++; }
  for (const a of ADMIN_ROSTER) { tally(await upsertByExt({ ...a, role: 'admin' })); s.admin++; }
  for (const c of CA_ROSTER) { tally(await upsertByExt({ extId: c.extId, name: c.name, email: c.email, role: 'ca' })); s.ca++; }

  if (retireFixtures) {
    for (const email of FIXTURES_TO_RETIRE) {
      const em = norm(email);
      const row = await db.prepare('SELECT uuid, active FROM staff WHERE lower(email) = ?').get(em);
      // Only retire genuine local fixtures (never one of our ext_id-backed rows).
      if (row && row.active) {
        await db.prepare('UPDATE staff SET active = 0 WHERE uuid = ?').run(row.uuid);
        s.retired++;
      }
    }
  }
  await logEvent(null, 'staff_directory_seeded', 'system', s);
  return s;
}

// Derive the CA->OM edge from CRM applicant rows: for every (career_associate_id,
// career_associate_manager_id) pair we have seen, point that CA's staff row at
// its manager's staff row. Accepts an array of info-shaped rows.
export async function linkCaManagers(infoRows = []) {
  let linked = 0;
  let unresolvedCa = 0;
  let unresolvedOm = 0;
  const done = new Set();
  for (const info of infoRows) {
    const caExt = caExtOf(info);
    const omExt = omExtOf(info);
    if (!caExt || !omExt) continue;
    const key = `${caExt}|${omExt}`;
    if (done.has(key)) continue;
    done.add(key);
    const ca = await findStaffByExtId(caExt);
    const om = await findStaffByExtId(omExt);
    if (!ca) { unresolvedCa++; continue; }
    if (!om) { unresolvedOm++; continue; }
    if (ca.manager_id !== om.uuid) {
      await db.prepare('UPDATE staff SET manager_id = ? WHERE uuid = ?').run(om.uuid, ca.uuid);
      linked++;
    }
  }
  return { pairs: done.size, linked, unresolvedCa, unresolvedOm };
}

// Per applicant: resolve the CA + OM staff uuids from one CRM info row, and
// opportunistically link that CA to its OM. Returns nulls when the CRM names a
// uuid we have no staff row for (the roster is authoritative, so this should
// only happen if the CRM references a person outside the operator's list).
export async function resolveTree(info = {}) {
  const caExt = caExtOf(info);
  const omExt = omExtOf(info);
  const ca = caExt ? await findStaffByExtId(caExt) : null;
  const om = omExt ? await findStaffByExtId(omExt) : null;
  if (ca && om && ca.manager_id !== om.uuid) {
    await db.prepare('UPDATE staff SET manager_id = ? WHERE uuid = ?').run(om.uuid, ca.uuid);
  }
  return {
    caId: ca?.uuid ?? null,
    opsId: om?.uuid ?? null,
    caExtId: caExt || null,
    omExtId: omExt || null,
    // Named in the CRM but not present as staff -> worth surfacing, not silent.
    caUnresolved: Boolean(caExt) && !ca,
    omUnresolved: Boolean(omExt) && !om
  };
}

// Directory health snapshot for the DEV pane.
export async function staffDirectoryStats() {
  const rows = await db.prepare("SELECT role, active, (ext_id IS NOT NULL) AS real FROM staff").all();
  const real = rows.filter((r) => r.real);
  const count = (pred) => rows.filter(pred).length;
  return {
    total: rows.length,
    realStaff: real.length,
    ca: count((r) => r.real && r.role === 'ca' && r.active),
    ops: count((r) => r.real && r.role === 'ops' && r.active),
    admin: count((r) => r.real && r.role === 'admin' && r.active),
    active: count((r) => r.active),
    retired: count((r) => !r.active)
  };
}
