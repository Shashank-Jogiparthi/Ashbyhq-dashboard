import { db, nowIso, uuid } from './index.js';
import { canonicalJobUrl, companyFromUrl } from '../core/job-url.js';

/* ------------------------------------------------------------------ */
/* STATE MACHINE                                                       */
/* ------------------------------------------------------------------ */

export const LEGAL_TRANSITIONS = {
  ASSIGNED: ['QUEUED', 'FAILED'],            // CA APPLY / CA SKIP
  QUEUED: ['APPLYING', 'FAILED'],            // worker claim / dev force-fail
  APPLYING: ['SUCCESS', 'PENDING', 'FAILED'],// worker outcomes
  PENDING: ['SUCCESS', 'FAILED'],            // dev manual resolution
  SUCCESS: [],
  FAILED: ['QUEUED', 'ASSIGNED']              // dev re-queue / worker reopen for missing-field CA input
};

export function canTransition(from, to) {
  return (LEGAL_TRANSITIONS[from] || []).includes(to);
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/* ------------------------------------------------------------------ */
/* EVENTS                                                              */
/* ------------------------------------------------------------------ */

export async function logEvent(applicationId, type, actor, payload = {}) {
  await db.prepare(
    'INSERT INTO application_events (application_id, type, actor, payload_json, ts) VALUES (?, ?, ?, ?, ?)'
  ).run(applicationId ?? null, type, actor, JSON.stringify(payload), nowIso());
}

export async function listEvents({ limit = 60, caUuid = null, managerUuid = null, type = null } = {}) {
  const scope = [];
  const params = [];
  if (caUuid) { scope.push('(a.ca_id = ?)'); params.push(caUuid); }
  if (managerUuid) { scope.push('(a.manager_id = ?)'); params.push(managerUuid); }
  const clauses = [];
  if (scope.length) clauses.push(`(${scope.join(' OR ')})`);
  // The DEV feed can be narrowed to one pipeline stage: type="link_scan" matches
  // link_scan_start / link_scan_done / link_scan_retry. Prefix equality (not
  // LIKE) so no backslash-escaping rules differ between the two backends.
  const typeFilter = String(type || '').trim().toLowerCase();
  if (typeFilter) {
    clauses.push('lower(substr(e.type, 1, ?)) = ?');
    params.push(typeFilter.length, typeFilter);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  params.push(limit);
  return db.prepare(`
    SELECT e.*, s.name AS actor_name, a.awl_id, jl.company, jl.title
    FROM application_events e
    LEFT JOIN applications a ON a.id = e.application_id
    LEFT JOIN job_links jl ON jl.id = a.link_id
    LEFT JOIN staff s ON s.uuid = e.actor
    ${where}
    ORDER BY e.ts DESC LIMIT ?
  `).all(...params);
}

/* ------------------------------------------------------------------ */
/* STAFF / AUTH                                                        */
/* ------------------------------------------------------------------ */

export function normalizeEmail(email) {
  return String(email || '').toLowerCase().trim();
}

// The sign-up form no longer asks for a name, so the staff directory shows a
// display name derived from the address: tags and the +suffix are dropped and
// the remaining separators become capitalised words.
export function displayNameFromEmail(email) {
  const local = normalizeEmail(email).split('@')[0].split('+')[0];
  const words = local.replace(/[._\-]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!words) return normalizeEmail(email);
  return words.split(' ').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
}

export async function findStaffByEmail(email) {
  return db.prepare('SELECT * FROM staff WHERE email = ?').get(normalizeEmail(email));
}

export async function findStaffByExtId(extId) {
  if (!extId) return null;
  return (await db.prepare('SELECT * FROM staff WHERE ext_id = ?').get(String(extId))) || null;
}

export async function listStaff(role = null) {
  return role
    ? db.prepare('SELECT * FROM staff WHERE role = ? ORDER BY name').all(role)
    : db.prepare('SELECT * FROM staff ORDER BY role, name').all();
}

export async function staffWithManagerName(staffUuid) {
  const row = await db.prepare(`
    SELECT s.*, m.name AS manager_name FROM staff s
    LEFT JOIN staff m ON m.uuid = s.manager_id WHERE s.uuid = ?
  `).get(staffUuid);
  return row || null;
}

export async function updateStaffManager(staffUuid, managerId) {
  await db.prepare('UPDATE staff SET manager_id = ? WHERE uuid = ?').run(managerId, staffUuid);
}

/* ---------------- ADMIN: role change + member removal ---------------- */

// Change a member's role (ADMIN only). Non-CA roles never keep a manager.
export async function updateStaffRole(staffUuid, role, actor) {
  if (!['ca', 'ops', 'dev', 'admin'].includes(role)) throw new HttpError(400, 'Unknown role');
  const target = await getStaff(staffUuid);
  if (!target) throw new HttpError(404, 'Staff member not found');
  if (target.role === role) throw new HttpError(400, `Already ${role.toUpperCase()}`);
  if (target.role === 'admin' && (await countAdmins()) <= 1) {
    throw new HttpError(400, 'Cannot demote the last ADMIN');
  }
  await db.prepare('UPDATE staff SET role = ?, manager_id = ? WHERE uuid = ?')
    .run(role, role === 'ca' ? target.manager_id : null, staffUuid);
  await logEvent(null, 'staff_role_changed', actor.uuid, { target: staffUuid, from: target.role, to: role });
  return getStaff(staffUuid);
}

async function countAdmins() {
  return (await db.prepare("SELECT COUNT(*) AS n FROM staff WHERE role = 'admin'").get()).n;
}

// Everything an ADMIN deletion would touch - shown in the confirm dialog.
export async function staffImpact(staffUuid) {
  return {
    applicants: (await db.prepare('SELECT COUNT(*) AS n FROM applicants WHERE ca_id = ? OR ops_id = ?').get(staffUuid, staffUuid)).n,
    activeApplications: (await db.prepare(
      "SELECT COUNT(*) AS n FROM applications WHERE (ca_id = ? OR manager_id = ?) AND status IN ('ASSIGNED','QUEUED','APPLYING')"
    ).get(staffUuid, staffUuid)).n,
    historyApplications: (await db.prepare(
      'SELECT COUNT(*) AS n FROM applications WHERE ca_id = ? OR manager_id = ?'
    ).get(staffUuid, staffUuid)).n,
    subordinateCas: (await db.prepare("SELECT COUNT(*) AS n FROM staff WHERE manager_id = ? AND role = 'ca'").get(staffUuid)).n
  };
}

export async function createStaff({ email, name, role, managerId = null }) {
  if (!['ca', 'ops', 'dev', 'admin'].includes(role)) throw new HttpError(400, 'Unknown role');
  const finalName = (name && String(name).trim()) || displayNameFromEmail(email);
  if (!finalName) throw new HttpError(400, 'Name is required');
  const record = {
    uuid: uuid(),
    email: normalizeEmail(email),
    name: finalName,
    role,
    manager_id: managerId,
    active: 1,
    last_sign_in: null,
    created_at: nowIso()
  };
  await db.prepare(`INSERT INTO staff (uuid, email, name, role, manager_id, active, last_sign_in, created_at)
              VALUES (?, ?, ?, ?, ?, 1, NULL, ?)`)
    .run(record.uuid, record.email, record.name, record.role, record.manager_id, record.created_at);
  await logEvent(null, 'staff_created', record.uuid, { email: record.email, role });
  return record;
}

export async function getStaff(staffUuid) {
  return db.prepare('SELECT * FROM staff WHERE uuid = ?').get(staffUuid);
}

export async function listCasForManager(managerUuid) {
  return db.prepare(
    "SELECT uuid, name, email FROM staff WHERE role = 'ca' AND manager_id = ? AND active = 1 ORDER BY name"
  ).all(managerUuid);
}

export async function touchSignIn(staffUuid) {
  await db.prepare('UPDATE staff SET last_sign_in = ? WHERE uuid = ?').run(nowIso(), staffUuid);
}

// PERMANENT member removal - ADMIN only (route-guarded). The member loses
// dashboard access (account + sessions deleted). Workload must be moved:
// either pass reassignTo (a same-role member inherits applicants, apps and
// subordinate CAs) or the member must have no applicants / active work.
export async function adminDeleteStaff(staffUuid, actor, reassignTo = null) {
  const target = await getStaff(staffUuid);
  if (!target) throw new HttpError(404, 'Staff member not found');
  if (target.uuid === actor.uuid) throw new HttpError(400, 'You cannot delete your own account');
  if (target.role === 'admin' && (await countAdmins()) <= 1) throw new HttpError(400, 'Cannot delete the last ADMIN');

  let reassign = null;
  if (reassignTo && reassignTo !== staffUuid) {
    reassign = await getStaff(reassignTo);
    if (!reassign) throw new HttpError(400, 'Reassignment target not found');
    if (reassign.role !== target.role) {
      throw new HttpError(400, `Reassignment target must also be ${target.role.toUpperCase()}`);
    }
  }

  const impact = await staffImpact(staffUuid);
  const blocking = impact.applicants + impact.activeApplications + impact.subordinateCas;
  if (!reassign && blocking > 0) {
    throw new HttpError(400,
      `${target.name} still owns ${impact.applicants} applicant(s), ${impact.activeApplications} active application(s), ` +
      `${impact.subordinateCas} CA(s). Pick a reassignment target first (or move their work).`);
  }

  await db.tx(async (t) => {
    if (reassign) {
      await t.prepare('UPDATE staff SET manager_id = ? WHERE manager_id = ?').run(reassign.uuid, staffUuid);
      await t.prepare('UPDATE applicants SET ca_id = ? WHERE ca_id = ?').run(reassign.uuid, staffUuid);
      await t.prepare('UPDATE applicants SET ops_id = ? WHERE ops_id = ?').run(reassign.uuid, staffUuid);
      await t.prepare('UPDATE applications SET ca_id = ? WHERE ca_id = ?').run(reassign.uuid, staffUuid);
      await t.prepare('UPDATE applications SET manager_id = ? WHERE manager_id = ?').run(reassign.uuid, staffUuid);
    } else {
      // No workload to move, but release any applicant linkage so rows
      // fall back to the shared pool instead of pointing at a ghost.
      await t.prepare('UPDATE applicants SET ca_id = NULL, ops_id = NULL WHERE ca_id = ? OR ops_id = ?')
        .run(staffUuid, staffUuid);
    }
    await t.prepare('DELETE FROM sessions WHERE staff_uuid = ?').run(staffUuid);
    await t.prepare('DELETE FROM otp_codes WHERE email = ?').run(target.email);
    await t.prepare('DELETE FROM staff WHERE uuid = ?').run(staffUuid);
  });
  await logEvent(null, 'staff_deleted', actor.uuid, {
    target: staffUuid, name: target.name, email: target.email, role: target.role,
    reassigned_to: reassign ? reassign.uuid : null, impact
  });
  return { deleted: staffUuid, name: target.name, role: target.role, reassigned_to: reassign ? reassign.uuid : null, impact };
}

/* ------------------------------------------------------------------ */
/* OTP CODES (mailer is a stub in core/mailer.js)                      */
/* ------------------------------------------------------------------ */

const OTP_TTL_MS = 5 * 60 * 1000;
const OTP_MAX_ATTEMPTS = 5;

export async function issueOtp(email) {
  const code = String(Math.floor(100000 + Math.random() * 900000));
  const expiresAt = new Date(Date.now() + OTP_TTL_MS).toISOString();
  await db.prepare(`INSERT INTO otp_codes (email, code, expires_at, attempts, created_at)
              VALUES (?, ?, ?, 0, ?)
              ON CONFLICT(email) DO UPDATE SET code = excluded.code, expires_at = excluded.expires_at, attempts = 0, created_at = excluded.created_at`)
    .run(email, code, expiresAt, nowIso());
  return code;
}

export async function verifyOtp(email, code) {
  const row = await db.prepare('SELECT * FROM otp_codes WHERE email = ?').get(email);
  if (!row) throw new HttpError(400, 'No code was issued for this email. Request a new one.');
  if (new Date(row.expires_at) < new Date()) throw new HttpError(400, 'Code expired. Request a new one.');
  if (row.attempts >= OTP_MAX_ATTEMPTS) throw new HttpError(400, 'Too many attempts. Request a new code.');
  if (row.code !== String(code).trim()) {
    await db.prepare('UPDATE otp_codes SET attempts = attempts + 1 WHERE email = ?').run(email);
    throw new HttpError(400, 'Invalid code.');
  }
  await db.prepare('DELETE FROM otp_codes WHERE email = ?').run(email);
  return true;
}

/* ------------------------------------------------------------------ */
/* SESSIONS                                                            */
/* ------------------------------------------------------------------ */

const SESSION_TTL_HOURS = 12;

export async function createSession(staffUuid) {
  const token = uuid();
  const expiresAt = new Date(Date.now() + SESSION_TTL_HOURS * 3600 * 1000).toISOString();
  await db.prepare('INSERT INTO sessions (token, staff_uuid, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .run(token, staffUuid, nowIso(), expiresAt);
  return { token, expiresAt };
}

export async function resolveSession(token) {
  if (!token) return null;
  const session = await db.prepare('SELECT * FROM sessions WHERE token = ?').get(token);
  if (!session) return null;
  if (new Date(session.expires_at) < new Date()) {
    await db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
    return null;
  }
  return getStaff(session.staff_uuid);
}

export async function destroySession(token) {
  await db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

/* ------------------------------------------------------------------ */
/* APPLICANTS / LINKS                                                  */
/* ------------------------------------------------------------------ */

export async function getApplicantsForCa(caUuid) {
  return db.prepare(`
    SELECT ap.*, am.name AS am_name, s.name AS ca_name, m.name AS manager_name,
      (SELECT COUNT(*) FROM applications a WHERE a.awl_id = ap.awl_id) AS job_count
    FROM applicants ap
    LEFT JOIN ams am ON am.uuid = ap.am_id
    LEFT JOIN staff s ON s.uuid = ap.ca_id
    LEFT JOIN staff m ON m.uuid = s.manager_id
    WHERE ap.ca_id = ?
    ORDER BY ap.full_name
  `).all(caUuid);
}

export async function getApplicantsForManager(managerUuid) {
  return db.prepare(`
    SELECT ap.*, am.name AS am_name, s.name AS ca_name, m.name AS manager_name,
      (SELECT COUNT(*) FROM applications a WHERE a.awl_id = ap.awl_id) AS job_count
    FROM applicants ap
    LEFT JOIN ams am ON am.uuid = ap.am_id
    LEFT JOIN staff s ON s.uuid = ap.ca_id
    LEFT JOIN staff m ON m.uuid = s.manager_id
    WHERE s.manager_id = ?
    ORDER BY s.name, ap.full_name
  `).all(managerUuid);
}

export async function getApplicantsAll() {
  return db.prepare(`
    SELECT ap.*, am.name AS am_name, s.name AS ca_name, m.name AS manager_name,
      (SELECT COUNT(*) FROM applications a WHERE a.awl_id = ap.awl_id) AS job_count
    FROM applicants ap
    LEFT JOIN ams am ON am.uuid = ap.am_id
    LEFT JOIN staff s ON s.uuid = ap.ca_id
    LEFT JOIN staff m ON m.uuid = s.manager_id
    ORDER BY s.name, ap.full_name
  `).all();
}

export async function getApplicantByAwlId(awlId) {
  return (await db.prepare('SELECT * FROM applicants WHERE awl_id = ?').get(awlId)) || null;
}

/* ------------------------------------------------------------------ */
/* APPLICATIONS                                                        */
/* ------------------------------------------------------------------ */

const APP_SELECT = `
  SELECT a.*, jl.company, jl.title, jl.url, jl.link_status,
         ap.full_name, ap.email AS applicant_email, ap.resume_address,
         s.name AS ca_name, am.name AS am_name, m.name AS manager_name
  FROM applications a
  JOIN job_links jl ON jl.id = a.link_id
  JOIN applicants ap ON ap.awl_id = a.awl_id
  LEFT JOIN staff s ON s.uuid = a.ca_id
  LEFT JOIN staff m ON m.uuid = a.manager_id
  LEFT JOIN ams am ON am.uuid = ap.am_id
`;

function scopeCondition(user) {
  if (user.role === 'ca') return 'a.ca_id = ?';
  if (user.role === 'ops') return 'a.manager_id = ?';
  return null;
}

function scopeParams(user) {
  if (user.role === 'ca' || user.role === 'ops') return [user.uuid];
  return [];
}

export async function getApplications(user, { status = null, awlId = null } = {}) {
  const parts = [];
  const params = [];
  const scope = scopeCondition(user);
  if (scope) { parts.push(scope); params.push(...scopeParams(user)); }
  if (status) { parts.push('a.status = ?'); params.push(status); }
  if (awlId) { parts.push('a.awl_id = ?'); params.push(awlId); }
  const where = parts.length ? `WHERE ${parts.join(' AND ')}` : '';
  return db.prepare(`${APP_SELECT} ${where} ORDER BY a.created_at DESC`).all(...params);
}

export async function getApplicationById(id) {
  return db.prepare(`${APP_SELECT} WHERE a.id = ?`).get(id);
}

export async function statusCounters(user) {
  const scopeCond = scopeCondition(user);
  const scope = scopeCond ? `WHERE ${scopeCond}` : '';
  const params = scopeParams(user);
  const rows = await db.prepare(`
    SELECT a.status, COUNT(*) AS n FROM applications a ${scope} GROUP BY a.status
  `).all(...params);
  const counters = { ASSIGNED: 0, QUEUED: 0, APPLYING: 0, SUCCESS: 0, PENDING: 0, FAILED: 0, TOTAL: 0 };
  for (const row of rows) {
    counters[row.status] = row.n;
    counters.TOTAL += row.n;
  }
  return counters;
}

function assertCanDecide(app, actor) {
  if (actor.role === 'dev' || actor.role === 'admin') return;
  if (actor.role === 'ca' && app.ca_id === actor.uuid) return;
  if (actor.role === 'ops' && app.manager_id === actor.uuid) return;
  throw new HttpError(403, 'This application is not in your scope.');
}

export async function applyApplication(id, actor) {
  const app = await db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  if (!app) throw new HttpError(404, 'Application not found');
  assertCanDecide(app, actor);
  await transition(id, 'QUEUED', actor.uuid, { queued_at: nowIso(), decision_by: actor.uuid, decision_at: nowIso() });
  return getApplicationById(id);
}

export async function skipApplication(id, actor, reason) {
  if (!reason || !String(reason).trim()) throw new HttpError(400, 'A reason is required to skip');
  const app = await db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  if (!app) throw new HttpError(404, 'Application not found');
  assertCanDecide(app, actor);
  await transition(id, 'FAILED', actor.uuid, {
    skip_reason: String(reason).trim(),
    fail_reason: `Skipped by ${actor.role.toUpperCase()}: ${String(reason).trim()}`,
    decision_by: actor.uuid,
    decision_at: nowIso(),
    finished_at: nowIso()
  });
  return getApplicationById(id);
}

export async function transition(id, to, actor, extraFields = {}) {
  const app = await db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  if (!app) throw new HttpError(404, 'Application not found');
  if (!canTransition(app.status, to)) {
    throw new HttpError(400, `Illegal transition ${app.status} -> ${to}`);
  }
  const sets = ['status = ?', 'updated_at = ?'];
  const values = [to, nowIso()];
  for (const [key, value] of Object.entries(extraFields)) {
    sets.push(`${key} = ?`);
    values.push(value);
  }
  values.push(id);
  await db.prepare(`UPDATE applications SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  await logEvent(id, `application.${to.toLowerCase()}`, actor, { from: app.status, ...extraFields });
  return getApplicationById(id);
}

/* ------------------------------------------------------------------ */
/* OPS CONTROLS (Operational Managers)                                 */
/* ------------------------------------------------------------------ */

export const ALL_STATUSES = ['ASSIGNED', 'QUEUED', 'APPLYING', 'SUCCESS', 'PENDING', 'FAILED'];

function assertInTree(app, actor) {
  if (actor.role === 'dev' || actor.role === 'admin') return;
  if (app.manager_id !== actor.uuid) throw new HttpError(403, 'This application is not in your tree.');
}

export async function opsReassignCa(id, actor, caUuid, moveApplicant = false) {
  const app = await db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  if (!app) throw new HttpError(404, 'Application not found');
  assertInTree(app, actor);
  const target = await db.prepare("SELECT * FROM staff WHERE uuid = ? AND role = 'ca'").get(caUuid);
  if (!target) throw new HttpError(400, 'Target staff member must be a CA');
  if (actor.role === 'ops' && target.manager_id !== actor.uuid) {
    throw new HttpError(400, 'That CA is not under you — re-assignment stays inside your tree');
  }
  await db.prepare('UPDATE applications SET ca_id = ?, manager_id = ?, updated_at = ? WHERE id = ?')
    .run(target.uuid, target.manager_id, nowIso(), id);
  if (moveApplicant) {
    // Move every application of this applicant (and the applicant record itself)
    await db.prepare('UPDATE applicants SET ca_id = ? WHERE awl_id = ?').run(target.uuid, app.awl_id);
    await db.prepare('UPDATE applications SET ca_id = ?, manager_id = ? WHERE awl_id = ?')
      .run(target.uuid, target.manager_id, app.awl_id);
  }
  await logEvent(id, 'ops_reassigned_ca', actor.uuid, {
    from_ca: app.ca_id, to_ca: target.uuid, move_applicant: !!moveApplicant
  });
  return getApplicationById(id);
}

export async function opsForceStatus(id, actor, status, reason) {
  const app = await db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  if (!app) throw new HttpError(404, 'Application not found');
  assertInTree(app, actor);
  if (!ALL_STATUSES.includes(status)) throw new HttpError(400, 'Unknown status');
  if (app.status === status) throw new HttpError(400, `Application is already ${status}`);
  if (!reason || !String(reason).trim()) throw new HttpError(400, 'A reason is required to force a status change');
  const fields = {
    updated_at: nowIso(),
    finished_at: ['SUCCESS', 'FAILED'].includes(status) ? nowIso() : null,
    fail_reason: status === 'FAILED' ? `Force-set to FAILED by ${actor.role.toUpperCase()}: ${String(reason).trim()}` : null,
    skip_reason: status === 'FAILED' ? String(reason).trim() : null
  };
  if (status === 'QUEUED') fields.queued_at = nowIso();
  const sets = ['status = ?'];
  const values = [status];
  for (const [key, value] of Object.entries(fields)) {
    sets.push(`${key} = ?`);
    values.push(value);
  }
  values.push(id);
  await db.prepare(`UPDATE applications SET ${sets.join(', ')} WHERE id = ?`).run(...values);
  await logEvent(id, 'ops_force_status', actor.uuid, { from: app.status, to: status, reason: String(reason).trim() });
  return getApplicationById(id);
}

/* ------------------------------------------------------------------ */
/* PER-CA / PER-OPS DRILL-DOWN (OPS + DEV dashboards)                   */
/* ------------------------------------------------------------------ */

export async function caSummary(caUuid) {
  const ca = await staffWithManagerName(caUuid);
  if (!ca || ca.role !== 'ca') throw new HttpError(404, 'CA not found');
  const applications = await getApplications({ role: 'ca', uuid: caUuid });
  return {
    ca: {
      uuid: ca.uuid, name: ca.name, email: ca.email,
      managerName: ca.manager_name || null, lastSignIn: ca.last_sign_in, active: !!ca.active
    },
    counters: await statusCounters({ role: 'ca', uuid: caUuid }),
    applicants: await getApplicantsForCa(caUuid),
    applications,
    events: await listEvents({ caUuid, limit: 25 })
  };
}

/* ------------------------------------------------------------------ */
/* ASSIGNMENT POOL (OPS attaches applicants to their CAs, quota-capped) */
/* ------------------------------------------------------------------ */

function slugUrl(url = '') {
  return String(url).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 120) || 'link';
}

export async function getQuotaUsage(managerUuid) {
  const mgr = await getStaff(managerUuid);
  const assigned = (await db.prepare(
    "SELECT COUNT(*) AS n FROM applicants WHERE ops_id = ? AND ca_id IS NOT NULL"
  ).get(managerUuid)).n;
  const unassigned = (await db.prepare(
    'SELECT COUNT(*) AS n FROM applicants WHERE ops_id = ? AND ca_id IS NULL'
  ).get(managerUuid)).n;
  return { quota: mgr?.applicant_quota ?? 0, assigned, unassigned };
}

// Applicants synced into an OPS manager's pool that still have no CA attached.
export async function getUnassignedPool(managerUuid) {
  return db.prepare(`
    SELECT ap.awl_id, ap.full_name, ap.email, ap.resume_address,
      (SELECT COUNT(*) FROM applicant_joblinks jl WHERE jl.awl_id = ap.awl_id AND jl.materialized = 0) AS pending_links
    FROM applicants ap
    WHERE ap.ca_id IS NULL AND (ap.ops_id = ? OR ap.ops_id IS NULL)
    ORDER BY ap.full_name
  `).all(managerUuid);
}

export async function updateStaffQuota(staffUuid, quota) {
  const n = Math.max(0, Number(quota) || 0);
  await db.prepare('UPDATE staff SET applicant_quota = ? WHERE uuid = ?').run(n, staffUuid);
  return getStaff(staffUuid);
}

// The OPS manager's central action: attach an unassigned applicant to one of
// their CAs, then materialise that applicant's pending job links into ASSIGNED
// applications so they appear in the CA's queue.
export async function assignApplicantToCa(awlId, caUuid, actor) {
  const applicant = await db.prepare('SELECT * FROM applicants WHERE awl_id = ?').get(awlId);
  if (!applicant) throw new HttpError(404, 'Applicant not found');
  const ca = await getStaff(caUuid);
  if (!ca || ca.role !== 'ca') throw new HttpError(400, 'Target must be a CA');

  if (actor.role === 'ops') {
    if (ca.manager_id !== actor.uuid) throw new HttpError(400, 'That CA is not under you');
    const usage = await getQuotaUsage(actor.uuid);
    if (applicant.ca_id == null && usage.assigned >= usage.quota) {
      throw new HttpError(400, `Applicant quota reached (${usage.assigned}/${usage.quota}) — ask DEV to raise it`);
    }
  } else if (actor.role !== 'dev' && actor.role !== 'admin') {
    throw new HttpError(403, 'Only an OPS manager (or DEV/ADMIN) can assign applicants to CAs');
  }

  const managerUuid = ca.manager_id;
  await db.prepare('UPDATE applicants SET ca_id = ?, ops_id = ?, assigned_at = ? WHERE awl_id = ?')
    .run(ca.uuid, managerUuid, nowIso(), awlId);

  const created = await materializeJoblinks(awlId, ca.uuid, managerUuid);
  await logEvent(null, 'applicant_assigned', actor.uuid, { awl_id: awlId, ca_id: ca.uuid, applications_created: created });
  return { applicant: await db.prepare('SELECT * FROM applicants WHERE awl_id = ?').get(awlId), applications_created: created };
}

async function materializeJoblinks(awlId, caUuid, managerUuid) {
  const pending = await db.prepare(
    'SELECT * FROM applicant_joblinks WHERE awl_id = ? AND materialized = 0'
  ).all(awlId);
  let count = 0;
  const linkGet = db.prepare('SELECT id FROM job_links WHERE url = ?');
  // RETURNING id works on both backends, so no lastInsertRowid is needed.
  const linkAdd = db.prepare(`INSERT INTO job_links (company, title, url, url_hash, link_status, seeded_at)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id`);
  const appGet = db.prepare('SELECT 1 FROM applications WHERE awl_id = ? AND link_id = ?');
  const appAdd = db.prepare(`INSERT INTO applications
    (awl_id, link_id, ca_id, manager_id, status, attempts, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'ASSIGNED', 0, ?, ?)`);
  const markDone = db.prepare('UPDATE applicant_joblinks SET materialized = 1 WHERE id = ?');
  for (const row of pending) {
    const linkUrl = canonicalJobUrl(row.url);
    let link = await linkGet.get(linkUrl)
      || (linkUrl !== row.url ? await linkGet.get(row.url) : null);
    if (!link) {
      const created = await linkAdd.get(row.company || companyFromUrl(linkUrl) || 'Unknown',
        row.title || 'Role', linkUrl, slugUrl(linkUrl), 'valid', nowIso());
      link = { id: Number(created.id) };
    }
    if (!(await appGet.get(awlId, link.id))) {
      await appAdd.run(awlId, link.id, caUuid, managerUuid, nowIso(), nowIso());
      count += 1;
    }
    await markDone.run(row.id);
  }
  return count;
}

/* ------------------------------------------------------------------ */
/* PRE-AUTOMATION SCAN CACHE (job_link_fields)                         */
/* ------------------------------------------------------------------ */

export function fieldKeyOf(str) {
  return String(str || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 200);
}

// Heuristic scan-time classifier: does this question look open-ended enough
// that Tier 1/2 deterministic rules will very likely fail and we need GenAI
// drafting? We flag textarea controls, and any question with a descriptive
// lead-in ("tell me", "describe", "why", "how would you", "what interests
// you", etc.). Radio/select/short-text fields are assumed answerable from
// the record; if Tier 2 abstains at draft time, the row is re-classified as
// `missing_fact` (category C) — that fallback lives in draft-service.js.
const OPEN_ENDED_RE = /\b(tell me|describe|self[- ]?introduction|in your own words|why (do you|are you|would you)|how (do you|would you|did you)|what interests you|what draws you|what excites|years of experience.{0,40}\?|essay|narrate|elaborate|elaborate on|walk me through|share.{0,20}experience|summar(y|ize|ise)\b)/i;
function looksOpenEnded(question, kind) {
  if (kind === 'textarea') return true;
  return OPEN_ENDED_RE.test(String(question || ''));
}

// Persist a scanned field inventory for a link (replaces any prior scan).
export async function saveJobLinkFields(linkId, fields = []) {
  // A re-scan replaces the inventory, but the semantic binding (which record
  // column answers which question) is a property of the QUESTION, not of the
  // scan. Carry it over by field_key so a re-scan never spends a second GenAI
  // call mapping questions we already mapped.
  const prior = await db.prepare('SELECT field_key, bound_key FROM job_link_fields WHERE link_id = ?').all(linkId);
  const priorBound = new Map(prior.map((r) => [r.field_key, r.bound_key]));
  const keys = [];
  await db.tx(async (t) => {
    const del = t.prepare('DELETE FROM job_link_fields WHERE link_id = ?');
    const ins = t.prepare(`INSERT INTO job_link_fields
    (link_id, field_key, question_text, field_type, options_json, answered, required, sort_order, scanned_at, needs_genai, question_summary, bound_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(link_id, field_key) DO UPDATE SET
      question_text = excluded.question_text,
      field_type = excluded.field_type,
      options_json = excluded.options_json,
      answered = excluded.answered,
      required = COALESCE(excluded.required, job_link_fields.required),
      needs_genai = excluded.needs_genai,
      question_summary = excluded.question_summary,
      bound_key = COALESCE(excluded.bound_key, job_link_fields.bound_key),
      scanned_at = excluded.scanned_at`);
    await del.run(linkId);
    const seen = new Set();
    for (const [i, f] of fields.entries()) {
      const rawQ = f.question || f.name || f.id || f.placeholder || `field_${i}`;
      let key = fieldKeyOf(rawQ) || `field_${i}`;
      while (seen.has(key)) key += '_';   // keep UNIQUE(link_id, field_key) intact
      seen.add(key);
      keys.push(key);
      const kind = f.kind || 'text';
      const carried = priorBound.has(key) ? priorBound.get(key) : (f.bound_key ?? null);
      await ins.run(linkId, key, String(rawQ).trim().slice(0, 1500), kind,
        JSON.stringify(f.options || []), f.answered ? 1 : 0,
        // NULL must stay NULL ("the form never said"), not collapse to 0/1.
        f.required === true ? 1 : (f.required === false ? 0 : null),
        i, nowIso(),
        looksOpenEnded(rawQ, kind) ? 1 : 0,
        f.question_summary ? String(f.question_summary).slice(0, 200) : null,
        carried == null ? null : String(carried));
    }
    // A question that is gone from the form has no control to fill any more, so
    // its stored answer is dead weight that would show up as a ghost row in the
    // CA pane. Guarded on a NON-EMPTY inventory: a failed/blank scan must never
    // wipe anybody's answers. (The value is re-derived from the record anyway.)
    if (keys.length && prior.length) {
      const marks = keys.map(() => '?').join(',');
      await t.prepare(`DELETE FROM applicant_field_answers WHERE link_id = ? AND field_key NOT IN (${marks})`)
        .run(Number(linkId), ...keys);
    }
  });
  await db.prepare("UPDATE job_links SET scan_status = 'scanned', scanned_at = ? WHERE id = ?").run(nowIso(), linkId);
  return fields.length;
}

// Record the semantic mapper's verdict for a batch of questions on one link.
// boundKey '' means "looked, the record genuinely has no such column" (an essay
// question) - that is a real answer and must not be re-mapped per applicant.
export async function saveFieldBindings(linkId, bindings = {}) {
  const entries = Object.entries(bindings);
  if (!entries.length) return 0;
  const stmt = db.prepare('UPDATE job_link_fields SET bound_key = ? WHERE link_id = ? AND field_key = ?');
  for (const [key, bound] of entries) await stmt.run(String(bound ?? ''), Number(linkId), key);
  return entries.length;
}

// Every CRM column we have ever seen in a stored applicant snapshot, normalised.
// The semantic mapper needs the WHOLE vocabulary, not one applicant's non-empty
// keys: bindings are cached per LINK and reused for everyone on it, so if the
// first applicant happens to leave `zip_or_country` blank the mapper must still
// be able to point a ZIP box at that column for the next one. A blank cell is
// simply absent from the record map, so a binding to it costs nothing and falls
// through to the CA.
let vocab = { at: 0, keys: [] };
export async function recordColumnVocabulary({ refresh = false } = {}) {
  if (!refresh && vocab.keys.length && Date.now() - vocab.at < 10 * 60 * 1000) return vocab.keys;
  const keys = new Set(vocab.keys);
  const sql = [
    "SELECT DISTINCT jsonb_object_keys(profile_json #> 'raw' #> 'additional_information') AS k FROM applicants",
    "SELECT DISTINCT jsonb_object_keys(profile_json #> 'raw' #> 'client') AS k FROM applicants"
  ];
  try {
    for (const q of sql) for (const r of await db.prepare(q).all()) if (r.k) keys.add(r.k);
  } catch {
    // SQLite (or a hosted backend without jsonb): read the snapshots directly.
    const rows = await db.prepare('SELECT profile_json FROM applicants ORDER BY source_updated_at DESC NULLS LAST LIMIT 500').all();
    for (const row of rows) {
      let p = {};
      try { p = JSON.parse(row.profile_json || '{}'); } catch { continue; }
      for (const section of ['client', 'additional_information']) {
        for (const k of Object.keys(p?.raw?.[section] || {})) keys.add(k);
      }
    }
  }
  vocab = { at: Date.now(), keys: [...keys] };
  return vocab.keys;
}

export async function listJobLinkFields(linkId) {
  const rows = await db.prepare('SELECT * FROM job_link_fields WHERE link_id = ? ORDER BY sort_order').all(linkId);
  return rows.map((r) => ({ ...r, options: JSON.parse(r.options_json || '[]') }));
}

// Links that are registered but have never produced a field inventory — the
// backlog the auto-scanner works through and the DEV "scan now" action lists.
export async function listUnscannedLinks() {
  return db.prepare(`SELECT l.id, l.url, l.company, l.title
    FROM job_links l
    WHERE NOT EXISTS (SELECT 1 FROM job_link_fields f WHERE f.link_id = l.id)
    ORDER BY l.id`).all();
}

export async function getJobLinkById(linkId) {
  return db.prepare('SELECT * FROM job_links WHERE id = ?').get(Number(linkId));
}

// job_links lookup by its canonical URL (the same key the scanner queues on).
export async function getJobLinkByUrl(url) {
  return db.prepare('SELECT * FROM job_links WHERE url = ?').get(String(url || ''));
}

export async function getScanJobByUrl(url) {
  return db.prepare('SELECT * FROM link_scan_jobs WHERE url = ?').get(String(url || ''));
}

// How many applications are blocked on a link (used to size the scan log line).
export async function countApplicationsOnLink(linkId) {
  const row = await db.prepare("SELECT COUNT(1) AS n FROM applications WHERE link_id = ? AND status IN ('ASSIGNED','QUEUED','PENDING')").get(linkId);
  return Number(row?.n || 0);
}
// Applications of a link that are waiting for its question inventory — the
// pre-scan worker pre-warms their draft answers the moment the scan lands.
export async function listApplicationsOnLink(linkId, statuses = ['ASSIGNED', 'QUEUED']) {
  const marks = statuses.map(() => '?').join(',');
  return db.prepare(`SELECT id, awl_id, link_id, ca_id, manager_id, status
    FROM applications WHERE link_id = ? AND status IN (${marks}) ORDER BY id`)
    .all(Number(linkId), ...statuses);
}

/* ------------------------------------------------------------------ */
/* PRE-SCAN WORKER QUEUE (link_scan_jobs)                              */
/* ------------------------------------------------------------------ */

// Queue the intent to scan, durably. One row per canonical URL: however many
// AWL-IDs share a link, it is scanned once. Re-queueing a DONE link is a no-op
// unless force is set (an explicit "rescan this"), and a RUNNING claim that is
// still fresh is never duplicated.
export async function enqueueScanJobs(urls = [], { reason = 'ingest', force = false } = {}) {
  const queued = [];
  const skipped = [];
  for (const raw of [].concat(urls)) {
    const url = String(raw || '').trim();
    if (!url) continue;
    const existing = await db.prepare('SELECT id, status, attempts FROM link_scan_jobs WHERE url = ?').get(url);
    if (!existing) {
      await db.prepare(`INSERT INTO link_scan_jobs (url, reason, status, attempts, max_attempts, fields, updated_at)
        VALUES (?, ?, 'PENDING', 0, 3, 0, ?)`).run(url, reason, nowIso());
      queued.push(url);
      continue;
    }
    if (existing.status === 'RUNNING') { skipped.push({ url, why: 'in_flight' }); continue; }
    if (existing.status === 'PENDING') { skipped.push({ url, why: 'already_queued' }); continue; }
    if (existing.status === 'DONE' && !force) { skipped.push({ url, why: 'already_scanned' }); continue; }
    // FAILED (or an explicit re-scan): start over with a clean backoff.
    await db.prepare(`UPDATE link_scan_jobs SET status = 'PENDING', reason = ?, attempts = 0,
      last_error = NULL, next_attempt_at = NULL, claimed_by = NULL, claimed_at = NULL, updated_at = ?
      WHERE id = ?`).run(reason, nowIso(), existing.id);
    queued.push(url);
  }
  return { queued, skipped };
}

// Give back a RUNNING row whose scanner died with it in hand (restart, killed
// browser). Anything claimed more than staleMs ago is presumed dead.
export async function requeueStaleScanClaims(staleMs) {
  const cutoff = new Date(Date.now() - staleMs).toISOString();
  const r = await db.prepare(`UPDATE link_scan_jobs SET status = 'PENDING', claimed_by = NULL,
    last_error = COALESCE(last_error, 'claim expired (scanner died)'), updated_at = ?
    WHERE status = 'RUNNING' AND (claimed_at IS NULL OR claimed_at < ?)`).run(nowIso(), cutoff);
  return r.changes || 0;
}

// Atomic-ish claim: SELECT then single-row CAS on status='PENDING'. Two servers
// asking at once cannot both get the row, and the same SQL works on SQLite.
export async function claimNextScanJob({ claimer, now = nowIso() } = {}) {
  const due = await db.prepare(`SELECT * FROM link_scan_jobs
    WHERE status = 'PENDING' AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
    ORDER BY id LIMIT 1`).get(now);
  if (!due) return null;
  const taken = await db.prepare(`UPDATE link_scan_jobs SET status = 'RUNNING', claimed_by = ?,
    claimed_at = ?, started_at = ?, attempts = attempts + 1, updated_at = ?
    WHERE id = ? AND status = 'PENDING'`).run(claimer, now, now, now, due.id);
  return taken.changes ? { ...due, status: 'RUNNING', attempts: due.attempts + 1 } : null;
}

// Close a claim. Failure backs off (15s * 2^n, capped at 10m) and re-arms the
// row as PENDING until max_attempts, then it parks as FAILED for the DEV pane.
// The elapsed time is deliberately not computed in SQL (no julianday() on
// Postgres): the worker reports it through markScanJobDuration().
export async function finishScanJob(id, { ok, fields = 0, error = null, maxAttempts = 3, attempts = 1 }) {
  const ts = nowIso();
  if (ok) {
    await db.prepare(`UPDATE link_scan_jobs SET status = 'DONE', fields = ?, last_error = NULL,
      finished_at = ?, claimed_by = NULL, updated_at = ? WHERE id = ?`)
      .run(Number(fields) || 0, ts, ts, Number(id));
    return 'DONE';
  }
  const permanent = attempts >= maxAttempts;
  const backoffMs = Math.min(10 * 60 * 1000, 15000 * (2 ** Math.max(0, attempts - 1)));
  await db.prepare(`UPDATE link_scan_jobs SET status = ?, fields = 0, last_error = ?,
    finished_at = ?, claimed_by = NULL, next_attempt_at = ?, updated_at = ? WHERE id = ?`)
    .run(permanent ? 'FAILED' : 'PENDING', String(error || 'scan failed').slice(0, 500), ts,
      permanent ? null : new Date(Date.now() + backoffMs).toISOString(), ts, Number(id));
  return permanent ? 'FAILED' : 'RETRY';
}

// Elapsed time of a finished scan, computed by the caller because the two
// backends have no shared date-diff function.
export async function markScanJobDuration(id, durationMs) {
  await db.prepare('UPDATE link_scan_jobs SET duration_ms = ?, updated_at = ? WHERE id = ?')
    .run(Math.max(0, Math.round(Number(durationMs) || 0)), nowIso(), Number(id));
}

export async function listScanJobs({ limit = 25 } = {}) {
  return db.prepare('SELECT * FROM link_scan_jobs ORDER BY updated_at DESC LIMIT ?').all(Number(limit) || 25);
}

export async function scanJobCounts() {
  const rows = await db.prepare('SELECT status, COUNT(1) AS n FROM link_scan_jobs GROUP BY status').all();
  const out = { PENDING: 0, RUNNING: 0, DONE: 0, FAILED: 0 };
  for (const r of rows) out[r.status] = Number(r.n);
  return out;
}

// DEV "retry everything that gave up": FAILED rows go back to PENDING fresh.
export async function requeueFailedScanJobs() {
  const r = await db.prepare(`UPDATE link_scan_jobs SET status = 'PENDING', attempts = 0,
    last_error = NULL, next_attempt_at = NULL, claimed_by = NULL, claimed_at = NULL, updated_at = ?
    WHERE status = 'FAILED'`).run(nowIso());
  return r.changes || 0;
}


/* ------------------------------------------------------------------ */
/* PRE-APPLY DRAFT ANSWERS (applicant_field_answers)                   */
/* ------------------------------------------------------------------ */

// Insert or update a single (applicant, link, field) answer row. Values are
// upserted so the CA editing a GenAI draft simply re-calls this with a new
// `source` and the same key.
export async function upsertFieldAnswer({ awlId, linkId, fieldKey, questionText, fieldType, options = [], value = null, source, evidence = [], sortOrder = 0, optional = 0 }) {
  if (!awlId || !linkId || !fieldKey) throw new Error('upsertFieldAnswer requires awlId, linkId, fieldKey');
  const ts = nowIso();
  return db.prepare(`INSERT INTO applicant_field_answers
    (awl_id, link_id, field_key, question_text, field_type, options_json, value, source, evidence_json, optional, sort_order, drafted_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(awl_id, link_id, field_key) DO UPDATE SET
      question_text = excluded.question_text,
      field_type = excluded.field_type,
      options_json = excluded.options_json,
      value = excluded.value,
      source = excluded.source,
      evidence_json = excluded.evidence_json,
      optional = excluded.optional,
      sort_order = excluded.sort_order,
      updated_at = excluded.updated_at`).run(
    awlId, linkId, fieldKey, String(questionText || '').slice(0, 400), fieldType || 'text',
    JSON.stringify(options || []), value === null || value === undefined ? null : String(value),
    source, JSON.stringify(evidence || []), optional ? 1 : 0, sortOrder, ts, ts);
}

export async function listFieldAnswers(awlId, linkId) {
  const rows = await db.prepare('SELECT * FROM applicant_field_answers WHERE awl_id = ? AND link_id = ? ORDER BY sort_order, id')
    .all(awlId, linkId);
  return rows.map((r) => ({ ...r, options: JSON.parse(r.options_json || '[]'), evidence: JSON.parse(r.evidence_json || '[]') }));
}

// Post-SUCCESS hygiene: an application that went through keeps ONLY its status,
// its failure reason (if any) and its two screenshot URLs. Everything the CA
// typed and the merged CRM profile blob are erased from the working cache — the
// durable copy of the submission already went back to the CRM, and a returning
// AWL-ID is re-fetched from there on its next assignment.
// Never called for FAILED / PENDING runs: those keep their data for the re-loop.
export async function purgeApplicantFormData(awlId, linkId, applicationId = null) {
  const removed = await db.prepare('DELETE FROM applicant_field_answers WHERE awl_id = ? AND link_id = ?')
    .run(awlId, linkId);
  // The merged profile is shared by every link this applicant is working, so it
  // is only erased once nothing else is still open for them. Answers are
  // per-(applicant, link) and always go.
  const open = await db.prepare(`SELECT COUNT(1) AS n FROM applications
    WHERE awl_id = ? AND status IN ('ASSIGNED','QUEUED','APPLYING','PENDING')`).get(awlId);
  let profileCleared = false;
  if (!Number(open?.n || 0)) {
    await db.prepare(`UPDATE applicants SET profile_json = '{}', parsed_profile_json = NULL,
      source_updated_at = NULL WHERE awl_id = ?`).run(awlId);
    profileCleared = true;
    // The draft pass caches the applicant's parsed resume text on disk next to
    // the same guarantee: once nothing is open for them, the parsed copy and the
    // downloaded PDF go with the profile. (Dynamic import: resume-cache.js
    // depends on this db module, so a static import would close the cycle.)
    try {
      const { purgeResume } = await import('../resume-cache.js');
      purgeResume(awlId);
    } catch { /* the erase already happened; a leftover cache file is retried next purge */ }
  }
  if (applicationId) {
    await db.prepare('UPDATE applications SET purged_at = ? WHERE id = ?').run(nowIso(), Number(applicationId));
  }
  return { answersRemoved: removed.changes || 0, profileCleared };
}

// True when an applicant row exists but holds no profile payload (never fetched,
// or purged after a previous success) — the trigger to pull it from the CRM.
export async function applicantNeedsProfile(awlId) {
  const row = await db.prepare('SELECT profile_json FROM applicants WHERE awl_id = ?').get(awlId);
  if (!row) return true;
  const raw = String(row.profile_json || '').trim();
  return raw === '' || raw === '{}';
}

// Persist CA edits coming back from the review pane. Skips unknown field_keys
// so a stale UI cannot poison a fresh scan, and stamps source='ca_edited'.
export async function applyCaEdits(awlId, linkId, edits = {}) {
  const known = await db.prepare('SELECT field_key, value, source FROM applicant_field_answers WHERE awl_id = ? AND link_id = ?')
    .all(awlId, linkId);
  const have = new Map(known.map((r) => [r.field_key, r]));
  // The review pane is built from the FORM inventory, so a CA can legitimately
  // answer a question the draft never produced a row for (a reworded caption, a
  // crashed pass). Dropping those keystrokes locked APPLY with no way out - the
  // question's real type + options are still known, so create the row.
  const inventory = new Map((await db.prepare('SELECT field_key, question_text, field_type, options_json, sort_order, required FROM job_link_fields WHERE link_id = ?')
    .all(linkId)).map((f) => [f.field_key, f]));
  const ts = nowIso();
  let n = 0;
  await db.tx(async (t) => {
    const upd = t.prepare("UPDATE applicant_field_answers SET value = ?, source = 'ca_edited', updated_at = ? WHERE awl_id = ? AND link_id = ? AND field_key = ?");
    // Same contract as upsertFieldAnswer, bound to THIS transaction: on the
    // hosted backend a nested db.prepare() would grab a second pool connection
    // and run outside the transaction.
    const ins = t.prepare(`INSERT INTO applicant_field_answers
      (awl_id, link_id, field_key, question_text, field_type, options_json, value, source, evidence_json, optional, sort_order, drafted_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(awl_id, link_id, field_key) DO UPDATE SET
        value = excluded.value, source = excluded.source, optional = excluded.optional,
        updated_at = excluded.updated_at`);
    for (const [k, v] of Object.entries(edits)) {
      const value = v === null || v === undefined || v === '' ? null : String(v);
      const cur = have.get(k);
      if (!cur) {
        const f = inventory.get(k) || inventory.get(fieldKeyOf(k));
        if (!f) continue;                       // not a question the form asks
        await ins.run(awlId, linkId, f.field_key, String(f.question_text || '').slice(0, 400),
          f.field_type || 'text', f.options_json || '[]', value, 'ca_edited',
          JSON.stringify(['typed by the CA']), Number(f.required) === 0 ? 1 : 0,
          f.sort_order || 0, ts, ts);
        n += 1;
        continue;
      }
      await upd.run(value, ts, awlId, linkId, k);
      n += 1;
    }
  });
  return n;
}

// True if every 'missing_fact' row for this (applicant, link) has been given
// a value (either by the CA or by an explicit Use-N/A edit). The APPLY route
// uses this to gate the QUEUED transition.
export async function hasBlockingMissingFacts(awlId, linkId) {
  // ONE rule, read off the FORM rather than off the draft rows: every question
  // the form requires must have a non-empty answer that is not a
  // 'not_applicable' note. Deriving it from the inventory is what makes the gate
  // agree with the review pane in every direction - a re-scan that reworded a
  // caption left no row at all (the old gate waved those through), and an older
  // draft pass could mark a row `optional` under rules that have since changed.
  // `required` is tri-state: NULL means the scan never saw a marker, so the
  // question is treated as required and the "[Optional]" text prefix is the only
  // way it can be let through.
  const optionalPrefix = "lower(trim(question_text)) NOT LIKE '[optional%' AND lower(trim(question_text)) NOT LIKE '(optional%'";
  const row = await db.prepare(`SELECT
    (SELECT COUNT(*) FROM job_link_fields j
      WHERE j.link_id = ?
        AND COALESCE(j.required, 1) <> 0
        AND ${optionalPrefix.replace(/question_text/g, 'j.question_text')}
        AND NOT EXISTS (
          SELECT 1 FROM applicant_field_answers a
          WHERE a.link_id = j.link_id AND a.field_key = j.field_key AND a.awl_id = ?
            AND a.value IS NOT NULL AND a.value <> '' AND a.source <> 'not_applicable')) AS open_required,
    (SELECT COUNT(*) FROM applicant_field_answers
      WHERE awl_id = ? AND link_id = ? AND source = 'missing_fact' AND optional = 0
        AND (value IS NULL OR value = '')) AS blank_rows`).get(
    linkId, awlId, awlId, linkId);
  return Number(row?.open_required || 0) + Number(row?.blank_rows || 0) > 0;
}

// Re-loop: when the engine reaches submit and finds required fields still blank
// (readiness.requiredUnfilled), it fails with those labels. We turn each one
// into a `missing_fact` answer row so the CA's review pane re-asks it before the
// next apply. Ashby's banner often names the SECTION ("Work Authorization"), not
// the exact control, so an exact key match fails and we would invent a bare
// text box. Instead we fuzzy-match the label to the scanned field inventory
// (job_link_fields) and inherit that control's real type + options, so the CA
// gets the actual radio/dropdown. Only when nothing matches do we fall back to
// a text input keyed by fieldKeyOf() so a CA answer still replays verbatim.
const MISSING_STOP = new Set(['the', 'for', 'any', 'this', 'that', 'with', 'are', 'you', 'have', 'has', 'and', 'not', 'from', 'about', 'would', 'could', 'should', 'their', 'them', 'been', 'being', 'will', 'your', 'our', 'who', 'how', 'what', 'when', 'where', 'why', 'did', 'does', 'can', 'may', 'all', 'other', 'into', 'them']);
function missingTokens(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').split(/\s+/)
    .filter((t) => t.length >= 3 && !MISSING_STOP.has(t));
}
function stemWord(t) { return t.length >= 6 ? t.slice(0, 6) : t; }
function bestScanMatchForLabel(label, scanned) {
  const lt = [...new Set(missingTokens(label).map(stemWord))];
  if (!lt.length) return null;
  let best = null; let bestScore = 0;
  for (const f of scanned) {
    const fs = new Set([...missingTokens(f.question_text), ...missingTokens(f.field_key)].map(stemWord));
    let hit = 0;
    for (const t of lt) if (fs.has(t)) hit += 1;
    const score = hit / lt.length;
    if (score > bestScore) { bestScore = score; best = f; }
  }
  return bestScore >= 0.5 ? best : null;
}
export async function recordSubmitMissingFields(awlId, linkId, labels = []) {
  const clean = [...new Set(labels.map((l) => String(l || '').trim()).filter(Boolean))];
  if (!clean.length) return 0;
  const scanned = await listJobLinkFields(linkId);
  const scanByKey = new Map(scanned.map((f) => [f.field_key, f]));
  const used = new Set();
  let n = 0;
  for (const [i, label] of clean.entries()) {
    let s = scanByKey.get(fieldKeyOf(label));
    if (!s) s = bestScanMatchForLabel(label, scanned);
    if (s && used.has(s.field_key)) continue; // already re-asked this control
    const key = s ? s.field_key : (fieldKeyOf(label) || `missing_${i}`);
    if (s) used.add(key);
    await upsertFieldAnswer({
      awlId, linkId, fieldKey: key,
      questionText: s?.question_text || label,
      fieldType: s?.field_type || 'text',
      options: s?.options || [],
      value: null, source: 'missing_fact', optional: 0,
      sortOrder: s?.sort_order != null ? s.sort_order : 9000 + i
    });
    n += 1;
  }
  return n;
}

// Reopen a missing-field FAILED application back to ASSIGNED so the owning CA
// sees it in their queue with the new blockers and must answer before re-applying.
export async function reopenForMissingFields(id, reason) {
  return transition(id, 'ASSIGNED', 'worker', {
    fail_reason: reason || 'Missing required field(s) — awaiting CA input',
    finished_at: null
  });
}

// New (AWL-ID -> link) pair from the connector; materialises immediately only
// if the applicant already has an attached CA. The URL is canonicalised first so
// one posting is one row however many tracking variants arrive (?source=, ?src=).
export async function upsertApplicantJoblink(awlId, { url, company = '', title = '' }) {
  const link = canonicalJobUrl(url);
  if (!link) return { materialized: false };
  const existing = await db.prepare(
    'SELECT id, materialized FROM applicant_joblinks WHERE awl_id = ? AND url = ?'
  ).get(awlId, link);
  if (existing) return { materialized: !!existing.materialized };
  await db.prepare('INSERT INTO applicant_joblinks (awl_id, url, company, title, materialized, added_at) VALUES (?, ?, ?, ?, 0, ?)')
    .run(awlId, link, company, title, nowIso());
  const applicant = await db.prepare('SELECT ca_id FROM applicants WHERE awl_id = ?').get(awlId);
  if (applicant?.ca_id) {
    const ca = await getStaff(applicant.ca_id);
    await materializeJoblinks(awlId, applicant.ca_id, ca?.manager_id || null);
    return { materialized: true };
  }
  return { materialized: false };
}

// Insert/refresh an applicant streamed from the external Postgres DB.
// Existing CA attachment is preserved; profile + resume address are refreshed.
export async function upsertExternalApplicant({ awlId, fullName, email, phone, resumeAddress, profileJson, extId, opsId }) {
  if (!awlId) throw new HttpError(400, 'Applicant is missing an AWL-ID');
  const existing = await db.prepare('SELECT * FROM applicants WHERE awl_id = ?').get(awlId);
  if (existing) {
    await db.prepare(`UPDATE applicants SET full_name = ?, email = ?, phone = ?, resume_address = ?,
                profile_json = ?, ext_id = ?, ops_id = COALESCE(?, ops_id), source_updated_at = ?
                WHERE awl_id = ?`)
      .run(fullName || existing.full_name, email || existing.email, phone ?? existing.phone,
        resumeAddress ?? existing.resume_address, profileJson ?? existing.profile_json,
        extId ?? existing.ext_id, opsId, nowIso(), awlId);
    return { created: false, applicant: await db.prepare('SELECT * FROM applicants WHERE awl_id = ?').get(awlId) };
  }
  await db.prepare(`INSERT INTO applicants (awl_id, full_name, email, phone, ca_id, ops_id, ext_id,
                resume_address, profile_json, source_updated_at)
              VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?)`)
    .run(awlId, fullName || awlId, email || '', phone || '', opsId ?? null, extId ?? null,
      resumeAddress || '', profileJson || '{}', nowIso());
  return { created: true, applicant: await db.prepare('SELECT * FROM applicants WHERE awl_id = ?').get(awlId) };
}

/* ------------------------------------------------------------------ */
/* WORKER SUPPORT (parallel runner reads these)                        */
/* ------------------------------------------------------------------ */

export async function listQueuedForWorker() {
  // Worker-only projection: includes ap.profile_json so the runner can hand
  // the full applicant record (answers + raw DB/JSON doc) to the child
  // process via PERSON_PROFILE_PATH. The shared APP_SELECT omits it to keep
  // the big blob out of the dashboard API responses.
  return db.prepare(`
    SELECT a.*, jl.company, jl.title, jl.url, jl.link_status,
           ap.full_name, ap.email AS applicant_email, ap.resume_address,
           ap.profile_json,
           s.name AS ca_name
    FROM applications a
    JOIN job_links jl ON jl.id = a.link_id
    JOIN applicants ap ON ap.awl_id = a.awl_id
    LEFT JOIN staff s ON s.uuid = a.ca_id
    WHERE a.status = 'QUEUED' ORDER BY a.queued_at ASC
  `).all();
}

export async function claimForRun(id, runId) {
  // Atomic claim: the status guard lives in the UPDATE itself, so two workers
  // can never both win the same application once the store is shared.
  const won = await db.prepare(`UPDATE applications SET status = 'APPLYING', run_id = ?, attempts = attempts + 1,
              updated_at = ? WHERE id = ? AND status = 'QUEUED' RETURNING id`)
    .get(runId, nowIso(), id);
  if (!won) return null; // lost the race / not queued
  await logEvent(id, 'application.applying', 'worker', { run_id: runId, from: 'QUEUED' });
  return getApplicationById(id);
}

export async function finishRun(id, outcome, extra = {}) {
  const legal = { success: 'SUCCESS', pending: 'PENDING', failed: 'FAILED' };
  const to = legal[outcome];
  if (!to) throw new HttpError(400, `Unknown run outcome: ${outcome}`);
  return transition(id, to, 'worker', {
    screenshot_path: extra.screenshot_path ?? null,
    screenshots_json: extra.screenshots_json ?? null,
    fail_reason: outcome === 'failed' ? (extra.reason || 'Application failed') : null,
    resolution_log_json: extra.resolution_log_json ?? null,
    finished_at: ['SUCCESS', 'FAILED'].includes(to) ? nowIso() : null
  });
}

export async function markRunCrash(id, reason) {
  return transition(id, 'FAILED', 'worker', {
    fail_reason: reason || 'Worker process exited abnormally',
    finished_at: nowIso()
  });
}

/* ------------------------------------------------------------------ */
/* EXECUTION HISTORY (automation_runs)                                 */
/* ------------------------------------------------------------------ */

export async function startRun({ runId, applicationId = null, awlId = null, linkId = null }) {
  await db.prepare(`INSERT INTO automation_runs (run_id, application_id, awl_id, link_id, status, started_at)
              VALUES (?, ?, ?, ?, 'running', ?)`).run(runId, applicationId, awlId, linkId, nowIso());
}

export async function finishStoredRun(runId, status, { reason = null, screenshotPath = null } = {}) {
  const row = await db.prepare('SELECT started_at FROM automation_runs WHERE run_id = ?').get(runId);
  const ended = nowIso();
  const durationMs = row?.started_at ? Date.parse(ended) - Date.parse(row.started_at) : null;
  await db.prepare(`UPDATE automation_runs SET status = ?, reason = ?, screenshot_path = ?,
              finished_at = ?, duration_ms = ? WHERE run_id = ?`)
    .run(status, reason, screenshotPath, ended, durationMs, runId);
}

export async function listRuns(limit = 50) {
  return db.prepare(`SELECT r.*, jl.company, jl.title, ap.full_name
    FROM automation_runs r
    LEFT JOIN job_links jl ON jl.id = r.link_id
    LEFT JOIN applicants ap ON ap.awl_id = r.awl_id
    ORDER BY r.started_at DESC LIMIT ?`).all(limit);
}

/* ------------------------------------------------------------------ */
/* DEV CONTROLS                                                        */
/* ------------------------------------------------------------------ */

export async function devRequeue(id, actor) {
  const app = await db.prepare('SELECT * FROM applications WHERE id = ?').get(id);
  if (!app) throw new HttpError(404, 'Application not found');
  if (app.status !== 'FAILED' && app.status !== 'QUEUED') {
    throw new HttpError(400, `Cannot re-queue from ${app.status}`);
  }
  if (app.status === 'FAILED') {
    return transition(id, 'QUEUED', actor, {
      fail_reason: null, skip_reason: null, queued_at: nowIso(), attempts: app.attempts
    });
  }
  return getApplicationById(id);
}

export async function devForceFail(id, actor, reason) {
  return transition(id, 'FAILED', actor, {
    fail_reason: reason || 'Force-failed by DEV',
    finished_at: nowIso()
  });
}

export async function devResolvePending(id, actor, outcome) {
  if (!['SUCCESS', 'FAILED'].includes(outcome)) throw new HttpError(400, 'Outcome must be SUCCESS or FAILED');
  return transition(id, outcome, actor, {
    finished_at: nowIso(),
    ...(outcome === 'FAILED' ? { fail_reason: 'Marked failed by DEV after PENDING' } : {})
  });
}

export async function readTable(name, limit = 200) {
  const allowed = ['staff', 'ams', 'job_links', 'applicants', 'applicant_joblinks', 'applications', 'application_events', 'sessions', 'system_state', 'job_link_fields', 'applicant_field_answers', 'automation_runs', 'link_scan_jobs'];
  if (!allowed.includes(name)) throw new HttpError(400, 'Table not inspectable');
  return db.prepare(`SELECT * FROM ${name} LIMIT ?`).all(limit);
}

export async function getSystemState(key, fallback = null) {
  const row = await db.prepare('SELECT value FROM system_state WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export async function setSystemState(key, value) {
  await db.prepare(`INSERT INTO system_state (key, value, updated_at) VALUES (?, ?, ?)
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`)
    .run(key, String(value), nowIso());
}
