import path from 'path';
import express from 'express';
import dotenv from 'dotenv';
import { ROOT_DIR } from './db/index.js';
import { migrate } from './db/index.js';
import {
  HttpError,
  normalizeEmail,
  findStaffByEmail,
  createStaff,
  getStaff,
  listStaff,
  staffWithManagerName,
  updateStaffManager,
  touchSignIn,
  issueOtp,
  verifyOtp,
  createSession,
  resolveSession,
  destroySession,
  getApplicantsForCa,
  getApplicantsForManager,
  getApplicantsAll,
  getApplications,
  getApplicationById,
  statusCounters,
  applyApplication,
  skipApplication,
  getUnassignedPool,
  getQuotaUsage,
  assignApplicantToCa,
  listCasForManager,
  updateStaffQuota,
  updateStaffRole,
  staffImpact,
  adminDeleteStaff,
  opsReassignCa,
  opsForceStatus,
  caSummary,
  logEvent,
  listEvents,
  devRequeue,
  devForceFail,
  devResolvePending,
  readTable,
  getSystemState,
  setSystemState
} from './db/store.js';
import { sendAuthCode } from './core/mailer.js';
import * as worker from './worker/runner.js';
import { enqueueLinkScans, scanQueueState, scanStateForUrl, start as startScanWorker } from './worker/link-scanner.js';
import { syncFromPostgres, syncApplicantByAwl, ingestDocument, isConfigured as connectorConfigured } from './connector/applicant-db.js';
import { runDraftPass, buildReviewQuestions } from './draft-service.js';
import {
  listFieldAnswers,
  applyCaEdits,
  hasBlockingMissingFacts,
  listJobLinkFields,
  saveJobLinkFields,
  upsertApplicantJoblink,
  getApplicantByAwlId,
  applicantNeedsProfile,
  listUnscannedLinks,
  getJobLinkById,
  requeueFailedScanJobs
} from './db/store.js';
import {
  upsertJobLinkQuestions,
  fetchJobLinkQuestions,
  listJobLinkQuestions,
  jobIdFromUrl,
  normalizeJobLink
} from './connector/joblink-questions.js';
import { appendJobLink, listAwlJobLinks } from './connector/awl-links.js';

dotenv.config({ path: path.join(ROOT_DIR, '.env') });
// The Azure Postgres + Gemini + Chrome settings live in the repo-root .env
dotenv.config({ path: path.resolve(ROOT_DIR, '..', '.env') });

const PORT = Number(process.env.PORT || 3100);
// Local use stays loopback-only (nothing on the network can reach the dashboard,
// which is deliberate - it holds applicant data). A deployed container has to
// answer its platform's proxy, which connects from OUTSIDE the container, so
// binding 127.0.0.1 there means "crashes / health check fails". Railway sets
// RAILWAY_ENVIRONMENT on every service; BIND_HOST overrides either way.
const BIND_HOST = process.env.BIND_HOST || (process.env.RAILWAY_ENVIRONMENT ? '0.0.0.0' : '127.0.0.1');
const VALID_ROLES = ['ca', 'ops', 'dev', 'admin'];

// OPS-tree endpoints a DEV/ADMIN may view for any manager by uuid.
function managerScopeUuid(req) {
  if ((req.user.role === 'dev' || req.user.role === 'admin') && req.query.managerId) return req.query.managerId;
  return req.user.uuid;
}

await migrate();
if (await getSystemState('worker_enabled') === null) {
  await setSystemState('worker_enabled', String(process.env.WORKER_ENABLED === 'true'));
}
if (process.env.WORKER_ENABLED === 'true') await setSystemState('worker_enabled', 'true');
worker.start().catch((e) => console.error('worker start:', e.message)); // poll loop always runs; it only CLAIMS when worker_enabled=true
startScanWorker();                          // pre-scan queue: claims link_scan_jobs rows
// Privacy sweep: the draft pass caches parsed resume text on disk. A successful
// apply erases it immediately; this clears anything left over from a run that
// never finished (crash, machine off) once its TTL has passed.
try {
  const { purgeStaleResumes } = await import('./resume-cache.js');
  const swept = purgeStaleResumes();
  if (swept) console.log(`resume cache: ${swept} expired file(s) erased`);
} catch { /* cache dir absent -> nothing to sweep */ }

const app = express();
app.use(express.json());
app.use(express.static(path.join(ROOT_DIR, 'public')));

/* ---------------------------- helpers ----------------------------- */

function bearer(req) {
  const header = req.headers.authorization || '';
  return header.startsWith('Bearer ') ? header.slice(7) : null;
}

async function requireAuth(req, res, next) {
  let user = null;
  try {
    user = await resolveSession(bearer(req));
  } catch (error) {
    // A store outage must surface as a clean 500, not an unhandled rejection.
    console.error('requireAuth:', error);
    return res.status(500).json({ error: 'Session lookup failed' });
  }
  if (!user) return res.status(401).json({ error: 'Not signed in' });
  if (!user.active) return res.status(403).json({ error: 'Account disabled' });
  req.user = user;
  next();
}

function requireRole(...roles) {
  return (req, res, next) => {
    if (!roles.includes(req.user.role)) return res.status(403).json({ error: 'Role not allowed' });
    next();
  };
}

function wrap(handler) {
  return (req, res) => {
    try {
      const out = handler(req, res);
      if (out && typeof out.then === 'function') return out.then(
        (value) => res.json(value ?? { ok: true }),
        (error) => handleError(res, error)
      );
      if (out !== undefined) res.json(out);
    } catch (error) {
      handleError(res, error);
    }
  };
}

function handleError(res, error) {
  if (error instanceof HttpError) return res.status(error.status).json({ error: error.message });
  console.error(error);
  return res.status(500).json({ error: error.message || 'Server error' });
}

/* ----------------------------- auth ------------------------------- */

// Step 1: sign-up / sign-in request -> issues the one-time code.
// Existing email = sign-in (role from record). New email = sign-up with chosen role.
app.post('/api/auth/request-code', wrap(async (req) => {
  const email = await normalizeEmail(req.body.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address');

  let user = await findStaffByEmail(email);
  let isNewAccount = false;
  if (!user) {
    const role = String(req.body.role || '').toLowerCase();
    if (!VALID_ROLES.includes(role)) throw new HttpError(400, 'Choose a role: CA, OPS, DEV or ADMIN');
    // ADMIN cannot be self-served: only the FIRST admin account can be
    // created through sign-up (bootstrap); further admins are promoted
    // by an existing ADMIN via /api/admin/staff/:uuid/role.
    if (role === 'admin' && (await listStaff('admin')).length) {
      throw new HttpError(403, 'ADMIN accounts cannot be self-created. Sign in with an existing ADMIN and promote a member from the Staff tab.');
    }
    let managerId = req.body.managerId || null;
    if (role === 'ca') {
      const opsList = await listStaff('ops');
      if (opsList.length && !managerId) throw new HttpError(400, 'Select your OPS manager to complete sign-up');
      if (managerId && !opsList.some((o) => o.uuid === managerId)) throw new HttpError(400, 'Unknown OPS manager');
    } else {
      managerId = null;
    }
    user = await createStaff({ email, name: req.body.name, role, managerId });
    isNewAccount = true;
  } else if (user.role === 'ca' && !user.manager_id && req.body.managerId) {
    await updateStaffManager(user.uuid, req.body.managerId);
    user = await getStaff(user.uuid);
  }

  const code = await issueOtp(user.email);
  await sendAuthCode(user.email, code);
  await touchSignIn(user.uuid);
  await logLogin(user, isNewAccount ? 'signup' : 'signin');
  return { sent: true, isNewAccount, email: user.email, role: user.role };
}));

async function logLogin(user, kind) {
  await logEvent(null, kind, user.uuid, { email: user.email, role: user.role });
}

// Step 2: verify the code -> session token.
app.post('/api/auth/verify-code', wrap(async (req) => {
  const email = await normalizeEmail(req.body.email);
  const user = await findStaffByEmail(email);
  if (!user) throw new HttpError(400, 'Account not found');
  await verifyOtp(email, req.body.code);
  const session = await createSession(user.uuid);
  await touchSignIn(user.uuid);
  return {
    token: session.token,
    user: { uuid: user.uuid, email: user.email, name: user.name, role: user.role }
  };
}));

app.post('/api/auth/logout', requireAuth, wrap(async (req) => {
  await destroySession(bearer(req));
  return { ok: true };
}));

app.get('/api/me', requireAuth, wrap(async (req) => {
  const rich = await staffWithManagerName(req.user.uuid);
  return {
    uuid: rich.uuid,
    email: rich.email,
    name: rich.name,
    role: rich.role,
    managerName: rich.manager_name || null,
    lastSignIn: rich.last_sign_in
  };
}));

// Public helper for the sign-up form (OPS-manager dropdown for new CAs).
app.get('/api/public/ops', wrap(async () => ({
  ops: (await listStaff('ops')).map((o) => ({ uuid: o.uuid, name: o.name, email: o.email }))
})));

/* --------------------------- CA routes ---------------------------- */

app.get('/api/ca/applicants', requireAuth, requireRole('ca', 'ops', 'dev', 'admin'), wrap(async (req) => {
  if (req.user.role === 'ca') return { applicants: await getApplicantsForCa(req.user.uuid) };
  if (req.user.role === 'ops') return { applicants: await getApplicantsForManager(req.user.uuid) };
  return { applicants: await getApplicantsAll() };
}));

app.get('/api/ca/applications', requireAuth, wrap(async (req) => ({
  applications: await getApplications(req.user, { status: req.query.status || null, awlId: req.query.awlId || null })
})));

app.get('/api/applications/:id', requireAuth, wrap(async (req) => {
  const app_ = await getApplicationById(Number(req.params.id));
  if (!app_) throw new HttpError(404, 'Application not found');
  if (req.user.role === 'ca' && app_.ca_id !== req.user.uuid) throw new HttpError(403, 'Out of scope');
  if (req.user.role === 'ops' && app_.manager_id !== req.user.uuid) throw new HttpError(403, 'Out of scope');
  return { application: app_ };
}));

app.post('/api/applications/:id/apply', requireAuth, wrap(async (req) => {
  const id = Number(req.params.id);
  const app_ = await getApplicationById(id);
  if (!app_) throw new HttpError(404, 'Application not found');
  assertAppDecideScope(app_, req.user);
  // Optional inline edits sent with APPLY are persisted first so the draft
  // gate below sees them, and so a re-run would replay the same confirmed
  // values. This keeps the "Approve + APPLY" one-click pattern on the CA card.
  if (req.body && req.body.edits && typeof req.body.edits === 'object') {
    await applyCaEdits(app_.awl_id, app_.link_id, req.body.edits);
  }
  if (await hasBlockingMissingFacts(app_.awl_id, app_.link_id)) {
    // A locked APPLY is a decision the DEV must be able to see: log the attempt
    // with the exact questions that were still open, then refuse.
    const open = (await buildReviewQuestions(app_.awl_id, app_.link_id))
      .filter((r) => !r.value && r.required && r.source !== 'not_applicable')
      .map((r) => ({ field_key: r.field_key, kind: r.field_type, question: String(r.question_text || '').slice(0, 120) }));
    await logEvent(id, 'apply_blocked', req.user.uuid, { blockers: open.length, questions: open.slice(0, 12) });
    throw new HttpError(400, 'Some questions still need your input (see "Needs your input" on the review pane).');
  }
  const result = { application: await applyApplication(id, req.user) };
  worker.kick(); // start a browser immediately (if worker enabled) instead of waiting for poll
  return result;
}));

/* ---------------- review-pane answers (pre-Apply draft) -------------
   GET  /answers           -> every row for this application, grouped by source
   POST /answers/draft     -> run/re-run the pre-Apply draft pass (idempotent)
   POST /answers/edit      -> persist CA edits; body = { edits: { field_key: value } }

   All three require the caller to be the assigned CA (or OPS/DEV/ADMIN who
   already has decide scope on this application). */

function assertAppDecideScope(app_, user) {
  if (user.role === 'ca' && app_.ca_id !== user.uuid) throw new HttpError(403, 'Out of scope');
  if (user.role === 'ops' && app_.manager_id !== user.uuid) throw new HttpError(403, 'Out of scope');
  if (user.role === 'dev' || user.role === 'admin') return;
}

const draftedOnOpen = new Set();
async function autoDraftOnce(app_) {
  const key = `${app_.awl_id}|${app_.link_id}`;
  if (draftedOnOpen.has(key)) return;
  draftedOnOpen.add(key);
  if ((await listFieldAnswers(app_.awl_id, app_.link_id)).length) return;   // normal case
  try {
    const outcome = await runDraftPass(app_.awl_id, app_.link_id, { log: () => {} });
    const { rows: detail, ...counts } = outcome;
    await logEvent(app_.id, 'draft_pass', 'auto-on-open', {
      awl_id: app_.awl_id, link_id: app_.link_id, ...counts,
      fields: (detail || []).map((r) => ({ key: r.key, source: r.source, via: r.via || 'rule' }))
    });
  } catch (err) {
    // Never fail the read because a draft failed: the pane shows the questions as
    // needing input and the DEV sees why in the activity feed.
    await logEvent(app_.id, 'draft_pass_failed', 'auto-on-open', {
      awl_id: app_.awl_id, link_id: app_.link_id, error: String(err.message || err).slice(0, 240)
    });
  }
}

async function answersPayload(app_) {
  let linkFields = await listJobLinkFields(app_.link_id);
  if (!linkFields.length) {
    // A scan may have been done by another install (or by the background queue
    // while this page sat open) — restore it before telling the CA it is unscanned.
    await ensureLinkInventory(app_);
    linkFields = await listJobLinkFields(app_.link_id);
  }
  // A link can reach a CA with an inventory and no answers at all (the scan came
  // from another install, the pre-warm worker was off, or its pass threw). Run the
  // draft now - it is browser-free and idempotent - so the pane opens with the
  // auto-filled answers rather than with 14 blank boxes. Once per application per
  // boot; if it fails the pane still shows every question, just unanswered.
  if (linkFields.length) await autoDraftOnce(app_);
  // THE FORM IS THE SOURCE OF TRUTH FOR WHICH QUESTIONS EXIST. Rendering only
  // the rows the draft happened to write is how questions disappeared from this
  // pane: a re-scan that reworded a caption pruned the old keys, and an applicant
  // whose draft pass never ran saw an empty card with APPLY locked and no reason.
  // Every scanned question is listed with its real type + options, whether or not
  // we managed to answer it; the CA can always type the answer themselves.
  const questions = await buildReviewQuestions(app_.awl_id, app_.link_id);
  const groups = { deterministic: [], genai: [], placeholder: [], missing_fact: [], ca_edited: [], needs_input: [], not_applicable: [], stale: [] };
  for (const r of questions) (groups[r.source] || (groups[r.source] = [])).push(r);
  const inFlight = linkFields.length ? null : await scanStateForUrl(app_.url);
  const blocking = questions.filter((r) => !r.value && r.required && r.source !== 'not_applicable' && r.source !== 'stale');
  return {
    applicationId: app_.id,
    awlId: app_.awl_id,
    linkId: app_.link_id,
    scanned: linkFields.length > 0,
    // 'pre_scanning' | 'queued' | 'failed' tell the UI to wait, not to give up.
    scanState: linkFields.length ? 'scanned' : (inFlight || 'unscanned'),
    fieldCount: linkFields.length,
    questionCount: questions.length,
    // Questions the form asks that NO draft pass ever answered - the pane shows
    // them as "Needs your input", and the DEV log needs to see why they are open.
    unanswered: questions.filter((r) => r.source === 'needs_input').length,
    blockers: blocking.length,
    groups
  };
}

app.get('/api/applications/:id/answers', requireAuth, wrap(async (req) => {
  const app_ = await getApplicationById(Number(req.params.id));
  if (!app_) throw new HttpError(404, 'Application not found');
  assertAppDecideScope(app_, req.user);
  return answersPayload(app_);
}));

app.post('/api/applications/:id/answers/draft', requireAuth, wrap(async (req) => {
  const app_ = await getApplicationById(Number(req.params.id));
  if (!app_) throw new HttpError(404, 'Application not found');
  assertAppDecideScope(app_, req.user);
  await ensureLinkInventory(app_);
  const outcome = await runDraftPass(app_.awl_id, app_.link_id, { log: () => {} });
  const { rows: detail, ...counts } = outcome;
  // Values never go into the event log: applicant answers are purged after a
  // successful apply but events are kept. Keys + sources are the audit trail.
  await logEvent(app_.id, 'draft_pass', req.user.uuid, {
    awl_id: app_.awl_id,
    link_id: app_.link_id,
    ...counts,
    fields: (detail || []).map((r) => ({ key: r.key, source: r.source, via: r.via || 'rule' }))
  });
  return { ...(await answersPayload(app_)), outcome };
}));

app.post('/api/applications/:id/answers/edit', requireAuth, wrap(async (req) => {
  const app_ = await getApplicationById(Number(req.params.id));
  if (!app_) throw new HttpError(404, 'Application not found');
  assertAppDecideScope(app_, req.user);
  const edits = req.body && req.body.edits;
  if (!edits || typeof edits !== 'object') throw new HttpError(400, 'body.edits required');
  const updated = await applyCaEdits(app_.awl_id, app_.link_id, edits);
  // Field-level audit trail for the DEV: WHICH questions the CA touched, never
  // the answer text itself (that data is purged after a successful apply).
  await logEvent(app_.id, 'ca_answers_edited', req.user.uuid, {
    awl_id: app_.awl_id, link_id: app_.link_id, updated,
    fields: Object.keys(edits).slice(0, 25)
  });
  return { ...(await answersPayload(app_)), updated };
}));

app.post('/api/applications/:id/skip', requireAuth, wrap(async (req) => ({
  application: await skipApplication(Number(req.params.id), req.user, req.body.reason)
})));

/* ------------------------- OPS routes ----------------------------- */

// CAs under the calling OPS manager (or a specific one when DEV/ADMIN passes ?managerId=).
app.get('/api/ops/team', requireAuth, requireRole('ops', 'dev', 'admin'), wrap(async (req) => {
  return { cas: await listCasForManager(managerScopeUuid(req)) };
}));

// Change which CA owns an application (optionally the whole applicant).
app.post('/api/ops/applications/:id/reassign', requireAuth, requireRole('ops', 'dev', 'admin'), wrap(async (req) => ({
  application: await opsReassignCa(Number(req.params.id), req.user, req.body.caUuid, !!req.body.moveApplicant)
})));

// Force an application to any status (bypasses the state machine; reason required).
app.post('/api/ops/applications/:id/force-status', requireAuth, requireRole('ops', 'dev', 'admin'), wrap(async (req) => ({
  application: await opsForceStatus(Number(req.params.id), req.user, req.body.status, req.body.reason)
})));

// Unassigned applicant pool for this OPS manager + quota usage + their CAs to pick from.
app.get('/api/ops/pool', requireAuth, requireRole('ops', 'dev', 'admin'), wrap(async (req) => {
  const managerUuid = managerScopeUuid(req);
  return {
    applicants: await getUnassignedPool(managerUuid),
    quota: await getQuotaUsage(managerUuid),
    cas: await listCasForManager(managerUuid)
  };
}));

// OPS manager attaches an applicant to one of their CAs (materialises ASSIGNED apps).
app.post('/api/ops/assign', requireAuth, requireRole('ops', 'dev', 'admin'), wrap(async (req) =>
  await assignApplicantToCa(String(req.body.awlId), req.body.caUuid, req.user)));

// Drill into one CA: their applicants, queue, counters, activity (OPS: own tree only).
app.get('/api/team/ca/:uuid', requireAuth, requireRole('ops', 'dev', 'admin'), wrap(async (req) => {
  if (req.user.role === 'ops') {
    const caRow = await getStaff(req.params.uuid);
    if (!caRow || caRow.role !== 'ca' || caRow.manager_id !== req.user.uuid) {
      throw new HttpError(403, 'That CA is not under you');
    }
  }
  return await caSummary(req.params.uuid);
}));

app.get('/api/ops/overview', requireAuth, requireRole('ops', 'dev', 'admin'), wrap(async (req) => {
  const managerUuid = managerScopeUuid(req);
  const cas = (await listStaff('ca')).filter((ca) => ca.manager_id === managerUuid);
  return {
    counters: await statusCounters({ role: 'ops', uuid: managerUuid }),
    cas: await Promise.all(cas.map(async (ca) => ({
      uuid: ca.uuid,
      name: ca.name,
      email: ca.email,
      active: !!ca.active,
      lastSignIn: ca.last_sign_in,
      applications: (await getApplications({ role: 'ca', uuid: ca.uuid })).length
    }))),
    applications: await getApplications({ role: 'ops', uuid: managerUuid }),
    applicants: await getApplicantsForManager(managerUuid),
    events: await listEvents({ managerUuid, limit: 40 })
  };
}));

/* ------------------------- shared activity ------------------------ */

app.get('/api/activity', requireAuth, wrap(async (req) => {
  if (req.user.role === 'ca') return { events: await listEvents({ caUuid: req.user.uuid, limit: 40 }) };
  if (req.user.role === 'ops') return { events: await listEvents({ managerUuid: req.user.uuid, limit: 40 }) };
  return { events: await listEvents({ limit: 80 }) };
}));

/* --------------------------- DEV routes --------------------------- */

app.get('/api/dev/overview', requireAuth, requireRole('dev', 'admin'), wrap(async () => ({
  counters: await statusCounters({ role: 'dev' }),
  staff: (await listStaff()).map((s) => ({ uuid: s.uuid, email: s.email, name: s.name, role: s.role, managerId: s.manager_id, applicantQuota: s.applicant_quota, active: !!s.active, lastSignIn: s.last_sign_in })),
  system: {
    workerEnabled: await getSystemState('worker_enabled') === 'true',
    worker: await worker.workerStatus(),
    connector: connectorConfigured() ? 'Postgres configured' : 'not configured (use Ingest for a JSON export)',
    database: 'OK (local SQLite)',
    api: 'OK'
  },
  queued: (await getApplications({ role: 'dev' })).filter((a) => ['QUEUED', 'APPLYING', 'PENDING'].includes(a.status))
})));

app.get('/api/dev/table/:name', requireAuth, requireRole('dev', 'admin'), wrap(async (req) => ({
  rows: await readTable(req.params.name, Number(req.query.limit || 200))
})));

// The DEV activity feed: every stage writes here (profile fetched, link queued
// /scanned, drafts generated, CA edits, screenshots uploaded, data purged).
// ?type=link_scan narrows it to one stage; ?limit caps the rows.
app.get('/api/dev/events', requireAuth, requireRole('dev', 'admin'), wrap(async (req) => ({
  events: await listEvents({
    limit: Math.min(500, Math.max(10, Number(req.query.limit) || 150)),
    type: req.query.type || null
  })
})));

app.post('/api/dev/applications/:id/requeue', requireAuth, requireRole('dev', 'admin'), wrap(async (req) => ({
  application: await devRequeue(Number(req.params.id), req.user.uuid)
})));

app.post('/api/dev/applications/:id/force-fail', requireAuth, requireRole('dev', 'admin'), wrap(async (req) => ({
  application: await devForceFail(Number(req.params.id), req.user.uuid, req.body.reason)
})));

app.post('/api/dev/applications/:id/resolve', requireAuth, requireRole('dev', 'admin'), wrap(async (req) => ({
  application: await devResolvePending(Number(req.params.id), req.user.uuid, req.body.outcome)
})));

app.post('/api/dev/staff/:uuid/manager', requireAuth, requireRole('dev', 'admin'), wrap(async (req) => {
  await updateStaffManager(req.params.uuid, req.body.managerId || null);
  return { staff: await staffWithManagerName(req.params.uuid) };
}));

app.post('/api/dev/worker', requireAuth, requireRole('dev', 'admin'), wrap(async (req) => {
  const enabled = req.body.enabled ? 'true' : 'false';
  await setSystemState('worker_enabled', enabled);
  await worker.start();
  if (enabled === 'true') worker.kick();
  return { workerEnabled: enabled === 'true', worker: await worker.workerStatus() };
}));

// Pull applicants + (AWL-ID -> link) pairs from the configured Postgres DB.
app.post('/api/dev/sync', requireAuth, requireRole('dev', 'admin'), wrap(async (req) => {
  if (!connectorConfigured()) throw new HttpError(400, 'Postgres not configured. Set PG_* env, or use Ingest to load a JSON export.');
  const sync = await syncFromPostgres({ opsId: req.body.opsId || null });
  // A sync can bring in links nobody has scanned yet — same rule as ingestion:
  // every assigned link must end up with a cached question inventory.
  return { sync, scan: await queueUnscannedLinks('sync') };
}));

// Load one exported applicant document (the { client, additional_information } shape).
app.post('/api/dev/ingest', requireAuth, requireRole('dev', 'admin'), wrap(async (req) => {
  const ingest = await ingestDocument(req.body.doc || req.body, { opsId: req.body.opsId || null });
  return { ingest, scan: await queueUnscannedLinks('ingest') };
}));

// Refresh (or create) a single applicant straight from the CRM tables by
// AWL-ID — the one key that resolves every detail of any applicant.
app.post('/api/dev/sync-one', requireAuth, requireRole('dev', 'admin'), wrap(async (req) => {
  if (!connectorConfigured()) throw new HttpError(400, 'Postgres not configured. Set PG_* env.');
  const awlId = String(req.body.awlId || req.body.awl_id || '').trim();
  if (!awlId) throw new HttpError(400, 'awlId is required');
  const sync = await syncApplicantByAwl(awlId, { opsId: req.body.opsId || null });
  return { awlId, sync, scan: await queueUnscannedLinks('sync-one') };
}));

// Any route that can introduce links funnels through here: links with no field
// inventory yet get a background pre-scan, so a CA never lands on an empty pane.
async function queueUnscannedLinks(reason) {
  const backlog = (await listUnscannedLinks()).map((l) => l.url);
  return backlog.length ? await enqueueLinkScans(backlog, { reason }) : { enabled: autoScanOn(), queued: [], skipped: [] };
}
function autoScanOn() {
  return String(process.env.AUTO_SCAN_ON_LINK ?? 'true').toLowerCase() !== 'false';
}

/* ---------------- job links: ingest + shared question cache -------- */
// The assignment of links to applicants lives in the CRM table
// public.ashby_joblinks (awl_id -> job_links[]); a normal sync reads it. This
// route is the write side: whatever DEV/ADMIN pastes here is appended to that
// same table (so it survives a re-sync and stays visible to the user), mirrored
// into the pending applicant_joblinks rows, and the link itself is registered in
// public.ashby_joblink_questions, which holds its pre-scanned questions.
function parseLinkPairs(body = {}) {
  const out = [];
  for (const p of (Array.isArray(body.pairs) ? body.pairs : [])) {
    out.push({
      awlId: String(p.awlId || p.awl_id || p.awl || '').trim(),
      url: String(p.url || p.job_link || p.link || '').trim()
    });
  }
  // Free-form paste: one pair per line, any separator, AWL id + http(s) URL in
  // either order. Lines starting with # are comments.
  for (const line of String(body.text || '').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    const awl = t.match(/AWL-?\d+/i);
    const url = t.match(/https?:\/\/\S+/i);
    if (awl && url) out.push({ awlId: awl[0].toUpperCase(), url: url[0] });
  }
  const single = String(body.awlId || '').trim();
  const singleUrl = String(body.url || '').trim();
  if (single && singleUrl) out.push({ awlId: single.toUpperCase(), url: singleUrl });
  return out.filter((p) => p.awlId && p.url);
}

app.post('/api/dev/links', requireAuth, requireRole('dev', 'admin'), wrap(async (req) => {
  const pairs = parseLinkPairs(req.body || {});
  if (!pairs.length) throw new HttpError(400, 'No (AWL-ID, job link) pairs found. Paste lines like: AWL-12  https://jobs.ashbyhq.com/…');
  const seen = new Set();
  const accepted = [];
  const rejected = [];
  const needScan = new Set();
  // 0. The paste contract is (AWL-ID, job link) and nothing else. So the first
  //    thing that happens is a CRM read: every column of client_profiles +
  //    clients_additional_info for that AWL-ID is normalised into the merged
  //    profile and stored in Supabase against that applicant alone. This is
  //    what makes a purged (already-applied) applicant usable again, and it is
  //    why no run ever has to go looking for data it was never given.
  const profiles = [];
  if (connectorConfigured()) {
    for (const awlId of [...new Set(pairs.map((p) => String(p.awlId).toUpperCase()))]) {
      try {
        const sync = await syncApplicantByAwl(awlId);
        profiles.push({ awlId, ok: true, created: !!sync.created, updated: !!sync.updated });
        await logEvent(null, 'applicant_profile_fetched', 'dev', { awl_id: awlId, seen: sync.seen, created: sync.created, updated: sync.updated });
      } catch (err) {
        const error = String(err.message || err).slice(0, 200);
        profiles.push({ awlId, ok: false, error });
        await logEvent(null, 'applicant_profile_fetch_failed', 'dev', { awl_id: awlId, error });
      }
    }
  }
  for (const { awlId, url } of pairs) {
    const dedupe = `${awlId}|${normalizeJobLink(url)}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    let applicant = await getApplicantByAwlId(awlId);
    if (!applicant && connectorConfigured()) {
      // Unknown AWL: try to pull the applicant straight from the CRM first.
      await syncApplicantByAwl(awlId).catch(() => {});
      applicant = await getApplicantByAwlId(awlId);
    }
    if (!applicant) { rejected.push({ awlId, url, error: 'AWL-ID not found in the applicant DB' }); continue; }
    // 1. remember the assignment in the CRM map (awl_id -> job_links[])
    const stored = await appendJobLink(awlId, url);
    // 2. queue it locally as a pending link
    await upsertApplicantJoblink(awlId, { url, company: '', title: '' });
    // 3. register the link itself so its questions can be scanned once for all
    const reg = await upsertJobLinkQuestions({ url });
    if (!reg.count) needScan.add(reg.link || normalizeJobLink(url));
    accepted.push({
      awlId, url: normalizeJobLink(url), job_id: reg.jobId,
      error: [stored.ok ? null : (stored.error || stored.skipped),
        reg.ok ? null : (reg.error || reg.skipped)].filter(Boolean).join('; ') || undefined
    });
  }
  await logEvent(null, 'links_ingested', 'dev', { awl_ids: [...new Set(accepted.map((a) => a.awlId))], accepted: accepted.length, rejected: rejected.length });
  // 4. pre-scan what has no questions yet — a durable background queue, one
  // browser at a time, so the paste returns immediately and the CA finds the
  // inventory (already answered as far as the applicant's data allows) waiting.
  const scan = needScan.size ? await enqueueLinkScans([...needScan], { reason: 'links_ingested' })
    : { enabled: true, queued: [], skipped: [] };
  const failed = accepted.filter((a) => a.error);
  return { accepted: accepted.filter((a) => !a.error), rejected: [...rejected, ...failed], links: accepted.map((a) => a.url), profiles, scan };
}));

// Explicit pre-scan control: queue specific links (by url or job_links.id), or
// the whole unscanned backlog. Same background queue the ingest path uses.
app.post('/api/dev/links/scan', requireAuth, requireRole('dev', 'admin'), wrap(async (req) => {
  const body = req.body || {};
  // { retry: true } re-arms every FAILED link; { force: true } re-scans the
  // named ones even if they already have an inventory (form changed upstream).
  if (body.retry) {
    const n = await requeueFailedScanJobs();
    await logEvent(null, 'link_scan_retried', 'dev', { requeued: n });
    return { requeued: n, queue: await scanQueueState(), scan: { queued: [], skipped: [] } };
  }
  const urls = [].concat(body.urls || body.url || []).map((u) => String(u || '').trim()).filter(Boolean);
  for (const id of [].concat(body.linkIds || body.linkId || [])) {
    const link = await getJobLinkById(Number(id));
    if (link?.url) urls.push(link.url);
  }
  if (body.all || (!urls.length && !Object.keys(body).length)) {
    urls.push(...(await listUnscannedLinks()).map((l) => l.url));
  }
  if (!urls.length) throw new HttpError(400, 'Nothing to scan — pass url/urls/linkIds, or { all: true } for the unscanned backlog.');
  const scan = await enqueueLinkScans(urls, { reason: 'dev_manual', force: !!body.force });
  await logEvent(null, 'link_scan_queued', 'dev', { requested: urls.length, queued: scan.queued.length, skipped: scan.skipped.length, force: !!body.force });
  return { scan, queue: await scanQueueState() };
}));

// Live view of the pre-scan worker: durable queue counts, what is running now
// and the most recent rows (attempts, errors, timings) for the DEV pane.
app.get('/api/dev/scan-queue', requireAuth, requireRole('dev', 'admin'), wrap(async () => ({
  ...(await scanQueueState()),
  unscanned: await listUnscannedLinks()
})));

// What the two CRM link tables currently hold: every registered link + how many
// questions are pre-scanned for it (0 = still needs a scan), and the
// (AWL-ID -> job_links[]) assignments.
app.get('/api/dev/joblinks', requireAuth, requireRole('dev', 'admin'), wrap(async () => {
  const [cache, assignments] = await Promise.all([listJobLinkQuestions(), listAwlJobLinks()]);
  return {
    configured: cache.ok,
    note: cache.ok ? undefined : (cache.error || cache.skipped || 'CRM not configured'),
    joblinks: cache.rows.map((r) => ({ ...r, scanned: r.question_count > 0 })),
    assignments: assignments.ok ? assignments.rows : []
  };
}));

// A link only ever needs scanning once. If this application's link has no local
// inventory yet, restore it from the shared cache instead of failing the draft
// pass — this is what lets one job link serve any number of applicants.
async function ensureLinkInventory(app_) {
  try {
    if ((await listJobLinkFields(app_.link_id)).length) return { hydrated: false, had: true };
    const cached = await fetchJobLinkQuestions(app_.url);
    if (!cached?.questions?.length) return { hydrated: false, had: false };
    await saveJobLinkFields(app_.link_id, cached.questions);
    await logEvent(app_.id, 'link_inventory_restored', 'server', { job_id: cached.job_id, questions: cached.questions.length });
    return { hydrated: true, count: cached.questions.length };
  } catch { return { hydrated: false }; }   // cache offline -> behave as before
}

app.post('/api/dev/staff/:uuid/quota', requireAuth, requireRole('dev', 'admin'), wrap(async (req) => ({
  staff: await updateStaffQuota(req.params.uuid, req.body.quota)
})));

/* --------------------------- ADMIN routes -------------------------- */
// ADMIN-only superpowers on top of full DEV access: change any member's role
// and permanently remove any member from the organisation + dashboard.

// Promote / demote a member (ca | ops | dev | admin).
app.post('/api/admin/staff/:uuid/role', requireAuth, requireRole('admin'), wrap(async (req) => ({
  staff: await updateStaffRole(req.params.uuid, String(req.body.role || '').toLowerCase(), req.user)
})));

// What a removal would touch (drives the confirm dialog: counts + peers).
app.get('/api/admin/staff/:uuid/impact', requireAuth, requireRole('admin'), wrap(async (req) => {
  const target = await getStaff(req.params.uuid);
  if (!target) throw new HttpError(404, 'Staff member not found');
  const peers = (await listStaff(target.role)).filter((s) => s.uuid !== target.uuid)
    .map((s) => ({ uuid: s.uuid, name: s.name, email: s.email }));
  return { target: { uuid: target.uuid, name: target.name, email: target.email, role: target.role }, impact: await staffImpact(req.params.uuid), peers };
}));

// PERMANENT removal. reassignTo (same-role peer) inherits their work; without
// it the member must have no applicants / active apps / subordinate CAs.
app.delete('/api/admin/staff/:uuid', requireAuth, requireRole('admin'), wrap(async (req) => ({
  result: await adminDeleteStaff(req.params.uuid, req.user, req.body.reassignTo || req.query.reassignTo || null)
})));  // end ADMIN routes

/* ------------------------------------------------------------------ */

app.get('/', (req, res) => res.redirect('/index.html'));
app.get('/dashboard', (req, res) => res.redirect('/dashboard.html'));

app.listen(PORT, BIND_HOST, () => {
  console.log(`\nASHBYHQ dashboard listening on http://localhost:${PORT} (bound to ${BIND_HOST}`
    + `${BIND_HOST === '127.0.0.1' ? ', local only)' : ' - reachable from the network)'}`);
});
