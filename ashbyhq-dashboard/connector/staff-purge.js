/* =====================================================================
   Staff purge — enforce "the directory is the CRM, nothing else".

   WHY this file exists: the platform grew out of @applywizz.local sign-in
   fixtures (a fake admin, a fake OPS->CA pair, a throwaway DEV). Once the
   real 59-CA / 2-OPS / 2-ADMIN roster is seeded from connector/staff-roster.js
   and every applicant is re-pointed onto its real CRM CA, those fixtures are
   pure noise: a CA signs in and sees phantom colleagues, and an OM drill-down
   counts people who never existed. The operator asked for them gone, keeping
   ONLY the addresses that end @applywizz.com / @applywizz.ai (the real staff,
   which includes the two ADMINs).

   THE RULE (not a setting): a staff row survives iff its email domain is
   exactly applywizz.com or applywizz.ai. Everything else is removed. Removal
   is done safely against the FK graph:

     * an applicant still owned by a doomed fixture is first re-pointed to its
       real CRM CA/OM (the caller injects that resolution, so this module never
       opens a Postgres pool itself);
     * a doomed staff row is DELETED only once nothing references it any more;
     * a doomed row that STILL owns anything afterwards - unresolvable work, or
       SUCCESS history we refuse to rewrite - is RETIRED (active = 0), never
       force-deleted, so the applicants.* / applications.* / staff.manager_id
       foreign keys can never be broken and no live work is orphaned.

   The reporting edges among doomed rows (a fixture CA under a fixture OPS) are
   detached first, so deleting the OPS does not trip its own CA's edge.

   Idempotent: run it again and there is nothing left to purge.
   ===================================================================== */
import { db, nowIso } from '../db/index.js';
import { normalizeEmail, getStaff, logEvent } from '../db/store.js';

// The ONLY domains that mean "a real person in the org chart". Anything else
// (applywizz.local, a stray gmail, a hand-typed address) is fixture noise.
const KEEP_DOMAINS = new Set(['applywizz.com', 'applywizz.ai']);

export function isApplywizzEmail(email) {
  const e = normalizeEmail(email);
  const at = e.lastIndexOf('@');
  if (at < 0) return false;
  return KEEP_DOMAINS.has(e.slice(at + 1));
}

// Placeholder list for `IN (?, ?, ...)`, backend-agnostic (db rewrites for pg).
const inClause = (n) => Array(n).fill('?').join(',');

// How many rows still pin a staff uuid, split so the caller can tell "history
// we keep" from "work we can move". Uses the SAME tables as staffImpact().
async function countRefs(t, uuid) {
  const applicants = (await t.prepare('SELECT COUNT(*) AS n FROM applicants WHERE ca_id = ? OR ops_id = ?').get(uuid, uuid)).n || 0;
  const appsAll = (await t.prepare('SELECT COUNT(*) AS n FROM applications WHERE ca_id = ? OR manager_id = ?').get(uuid, uuid)).n || 0;
  const appsOpen = (await t.prepare("SELECT COUNT(*) AS n FROM applications WHERE (ca_id = ? OR manager_id = ?) AND status <> 'SUCCESS'").get(uuid, uuid)).n || 0;
  const subordinates = (await t.prepare('SELECT COUNT(*) AS n FROM staff WHERE manager_id = ?').get(uuid)).n || 0;
  return {
    applicants: Number(applicants),
    applications: Number(appsAll),
    openApplications: Number(appsOpen),
    historyApplications: Number(appsAll) - Number(appsOpen),
    subordinates: Number(subordinates)
  };
}

function refsBlockDeletion(r) {
  return r.applicants > 0 || r.applications > 0 || r.subordinates > 0;
}

/**
 * Remove every non-@applywizz staff row.
 *
 * @param {Object}   opts
 * @param {Function} [opts.resolveApplicant] async (applicantRow) => { caId, opsId }
 *        the real staff uuids an applicant should move to (resolved from the
 *        CRM by the caller). Returning null/undefined, or ids that are NOT
 *        whitelisted, means "cannot re-point" - and its doomed CA is retired.
 * @param {boolean}  [opts.dryRun]   compute + report, change nothing.
 * @param {string}   [opts.actor]    event attribution.
 * @param {Set}      [opts.onlyUuids] TEST SCOPE: restrict the doomed candidate
 *        set to these uuids (still only those that fail the domain rule). In
 *        production it is omitted, so the whole non-@applywizz directory is
 *        purged. It lets the flow verifier exercise the real rule against the
 *        SHARED hosted DB without deleting anybody else's fixture.
 * @returns report { kept, doomed, reassignable, deleted[], retired[] }
 */
export async function purgeLocalStaff({ resolveApplicant = null, dryRun = false, actor = 'system', onlyUuids = null } = {}) {
  const staff = await db.prepare('SELECT * FROM staff').all();
  // A row is doomed when it fails the domain rule - and, if a test narrowed the
  // scope, when it is one of the named uuids. Production passes no scope.
  const doomed = staff.filter((s) => !isApplywizzEmail(s.email) && (!onlyUuids || onlyUuids.has(s.uuid)));
  const doomedIds = new Set(doomed.map((s) => s.uuid));
  const kept = staff.filter((s) => !doomedIds.has(s.uuid));   // survivors
  const keptUuids = new Set(kept.map((s) => s.uuid));
  const doomedUuids = doomed.map((s) => s.uuid);

  const report = {
    dryRun,
    kept: kept.length,
    doomed: doomed.length,
    reassignable: 0,
    wouldDelete: 0,
    wouldRetire: 0,
    projection: [],
    deleted: [],
    retired: []
  };
  if (!doomed.length) return report;

  // 1. Decide the re-point plan BEFORE touching anything (resolveApplicant may
  //    reach the CRM). Only ever move work onto a whitelisted (surviving) row.
  const owned = await db.prepare(
    `SELECT * FROM applicants WHERE ca_id IN (${inClause(doomedUuids.length)}) OR ops_id IN (${inClause(doomedUuids.length)})`
  ).all(...doomedUuids, ...doomedUuids);

  const plan = [];
  for (const app of owned) {
    const tgt = resolveApplicant ? await resolveApplicant(app) : null;
    const newCa = tgt?.caId && keptUuids.has(tgt.caId) ? tgt.caId : null;
    const newOps = tgt?.opsId && keptUuids.has(tgt.opsId) ? tgt.opsId : null;
    if (!newCa && !newOps) continue;             // unresolved -> its doomed CA is retired
    const newManager = newOps || (newCa ? (await getStaff(newCa))?.manager_id || null : null);
    plan.push({ awlId: app.awl_id, caId: newCa, opsId: newOps, managerId: newManager });
    report.reassignable += 1;
  }

  if (dryRun) {
    // Report projected fate without writing: a doomed row is deletable if all
    // the work on it can move (or there is none) and it has no unmovable refs.
    const plannedAwls = new Set(plan.map((p) => p.awlId));
    for (const s of doomed) {
      const refs = await countRefs(db, s.uuid);
      const stillOwned = await db.prepare(
        'SELECT awl_id FROM applicants WHERE ca_id = ? OR ops_id = ?'
      ).all(s.uuid, s.uuid);
      const unresolvable = stillOwned.filter((r) => !plannedAwls.has(r.awl_id)).length;
      const history = refs.historyApplications > 0;
      // Deletable once its movable work is gone: nothing unresolvable, no
      // SUCCESS history, no subordinate edge left behind.
      const deletable = unresolvable === 0 && !history && refs.subordinates === 0;
      if (deletable) report.wouldDelete += 1; else report.wouldRetire += 1;
      report.projection.push({ uuid: s.uuid, email: s.email, role: s.role, refs, unresolvableApplicants: unresolvable, fate: deletable ? 'delete' : 'retire' });
    }
    return report;
  }

  // 2. Apply atomically. Re-point -> detach doomed edges -> delete/retire.
  await db.tx(async (t) => {
    for (const p of plan) {
      if (p.caId) {
        await t.prepare('UPDATE applicants SET ca_id = ? WHERE awl_id = ?').run(p.caId, p.awlId);
        // Live work follows the applicant; SUCCESS rows stay as history (the
        // same rule upsertExternalApplicant applies).
        await t.prepare(
          "UPDATE applications SET ca_id = ?, manager_id = ?, updated_at = ? WHERE awl_id = ? AND status <> 'SUCCESS'"
        ).run(p.caId, p.managerId, nowIso(), p.awlId);
      }
      if (p.opsId) {
        await t.prepare('UPDATE applicants SET ops_id = ? WHERE awl_id = ?').run(p.opsId, p.awlId);
      }
    }

    // Detach every manager edge that points at a doomed row: doomed CAs under a
    // doomed OPS (both going) and, defensively, any survivor mis-parented to a
    // fixture. Doing this first means deleting an OPS can't trip its own CA.
    await t.prepare(`UPDATE staff SET manager_id = NULL WHERE manager_id IN (${inClause(doomedUuids.length)})`)
      .run(...doomedUuids);

    for (const s of doomed) {
      // Never strand the last ADMIN (defensive; the real ADMINs are @applywizz
      // and are not in `doomed`, so this only guards a hand-made fixture admin).
      if (s.role === 'admin') {
        const admins = (await t.prepare("SELECT COUNT(*) AS n FROM staff WHERE role = 'admin'").get()).n || 0;
        if (Number(admins) <= 1) {
          report.retired.push({ uuid: s.uuid, email: s.email, role: s.role, reason: 'last-admin' });
          await t.prepare('UPDATE staff SET active = 0 WHERE uuid = ?').run(s.uuid);
          continue;
        }
      }
      const refs = await countRefs(t, s.uuid);
      if (refsBlockDeletion(refs)) {
        await t.prepare('UPDATE staff SET active = 0 WHERE uuid = ?').run(s.uuid);
        report.retired.push({ uuid: s.uuid, email: s.email, role: s.role, reason: 'still-referenced', refs });
      } else {
        // Re-check the doomed email/otp so a re-signup can't inherit the shell.
        await t.prepare('DELETE FROM sessions WHERE staff_uuid = ?').run(s.uuid);
        await t.prepare('DELETE FROM otp_codes WHERE email = ?').run(normalizeEmail(s.email));
        await t.prepare('DELETE FROM staff WHERE uuid = ?').run(s.uuid);
        report.deleted.push({ uuid: s.uuid, email: s.email, role: s.role, refs });
      }
    }
  });

  await logEvent(null, 'staff_purged', actor, {
    dryRun: false, kept: report.kept, doomed: report.doomed,
    reassigned: report.reassignable, deleted: report.deleted.length, retired: report.retired.length
  });
  return report;
}
