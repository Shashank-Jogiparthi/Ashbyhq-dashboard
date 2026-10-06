import path from 'path';
import express from 'express';
import dotenv from 'dotenv';
import { ROOT_DIR, db } from './db/index.js';
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
  listPendingLinksForCa,
  getApplicantsAll,
  getApplications,
  getApplicationById,
  statusCounters,
  applyApplication,
  skipApplication,
  getUnassignedPool,
  getQuotaUsage,
  caQuotaUsage,
  getGlobalCaQuota,
  setGlobalCaQuota,
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
  setSystemState,
  getCaWorkHistory,
  getCaWorkHistoryDetail,
  listUnassignedApplicants,
  upsertExternalApplicant
} from './db/store.js';
import { sendAuthCode } from './core/mailer.js';
import { parseAwlLinkTable } from './core/joblink-csv.js';
import os from 'node:os';
import { describeConnectorEnv } from './core/applicant-source.js';
import * as worker from './worker/runner.js';
import { enqueueLinkScans, scanQueueState, scanStateForUrl, start as startScanWorker } from './worker/link-scanner.js';
import { checkBrowser } from './core/browser-check.js';
import { syncFromPostgres, syncApplicantByAwl, ingestDocument, normalizeAwlId, isConfigured as connectorConfigured, buildStaffTree, buildAwlCaIndex, diagnoseAssignment } from './connector/applicant-db.js';
import { staffDirectoryStats } from './connector/staff-directory.js';
import { purgeLocalStaff, isForbiddenLoginEmail, removeDeadFixtures } from './connector/staff-purge.js';
import { buildCaData, caDataStats } from './connector/ca-data.js';
import { refreshWorkHistory } from './connector/work-history.js';
import { stageResumeForAwl, stageResumesForPending } from './connector/resume-store.js';
import {
  EXT_API_KEYS, extApiSettings, clearExtApiCache, caEmails, workHistory, clientDetails
} from './connector/external-apis.js';
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
// Self-serve sign-up may ONLY ever mint CA / OM(ops) / DEV. ADMIN is not a
// sign-up choice (the 3 existing admins signed in with their emails and are
// grandfathered; more admins come only via /api/admin/staff/:uuid/role), and
// the role must be CHOSEN — there is no default and no other allowed value.
const SIGNUP_ROLES = ['ca', 'ops', 'dev'];
export function assertSignupRole({ email, role, adminLookup }) {
  const e = normalizeEmail(email);
  const r = String(role || '').toLowerCase();
  // ADMIN is never a sign-up choice, whichever email asks for it.
  if (r === 'admin') {
    return Promise.reject(new HttpError(403,
      adminLookup
        ? 'This email already has an ADMIN account. Switch to "Sign in".'
        : 'ADMIN is not a sign-up choice. Sign in with your existing account; an existing ADMIN promotes others from the Staff tab.'));
  }
  if (!SIGNUP_ROLES.includes(r)) {
    throw new HttpError(400, 'Sign-up requires choosing a role: CA, OM or DEV');
  }
  // The grandfathered org mailbox domains (the 59 CA / 3 admin emails) never
  // self-mint an account: their owners already exist and sign in by email.
  if (e.endsWith('@applywizz.com') || e.endsWith('@applywizz.ai')) {
    return Promise.reject(new HttpError(403,
      'This company email already belongs to an existing team member. Switch to "Sign in".'));
  }
  return Promise.resolve(r);
}

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
// WORKER_ENABLED=false deliberately does NOT write here: the flag lives in a
// shared database, so a per-host brake belongs in the worker itself (see
// HOST_OPT_OUT in worker/runner.js), not in the row every other host reads.
// Capability probe, fired the instant the process boots: "can this machine
// actually launch a browser?" TWO verdicts, because the two workers do not ask
// the same question - the engine applies HEADED (a real window, which a
// display-less container cannot make) and scans HEADLESS. Measuring only the
// headless case is what let a container call itself ready and then destroy real
// CA applications at `browserType.launch`. They run one after the other rather
// than at once: two cold browser launches on a small host compete for memory,
// and a hung probe would report both as incapable.
// NOT awaited - a first launch can legitimately take tens of seconds and the
// HTTP server must never wait for it; until a verdict lands, every tick simply
// declines to claim that kind of work, which is the safe direction.
checkBrowser({ mode: 'apply' })
  .catch(() => {})
  .then(() => checkBrowser({ mode: 'scan' }))
  .catch(() => {});                          // answers on its own; see the note above
worker.start().catch((e) => console.error('worker start:', e.message)); // poll loop always runs; it only CLAIMS when worker_enabled=true
startScanWorker();                          // pre-scan queue: claims link_scan_jobs rows
// Staff directory: seed the committed org-chart roster (59 CAs + 2 OPS + 2
// ADMIN) as real staff and derive every CA -> OM edge from the CRM, so the
// AWL-ID -> CA -> OM(CAM) tree exists BEFORE the first applicant sync resolves
// against it. Idempotent, and a failure here must never stop the HTTP server,
// so it is fired and logged, not awaited.
buildStaffTree()
  .then((r) => console.log(`staff directory: seeded ${r.seed.created} new / ${r.seed.updated} existing, retired ${r.seed.retired}; CA->OM links: ${r.link.linked ?? 0}${r.link.skipped ? ` (${r.link.skipped})` : ''}`))
  .catch((e) => console.error('staff directory seed:', e.message));
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

// Sign-in / sign-up entry point. PASSWORDLESS in this build: it resolves (or
// creates) the account, then mints the session token directly and returns it —
// no one-time code is issued or mailed, and the portal logs straight in.
// The portal sends an explicit `mode`: SIGN IN never creates an account and
// SIGN UP never logs into an existing one. Defaulting to 'signup' keeps older
// callers (and the CLI helpers) working unchanged.
// NOTE: role is still self-selected on sign-up and this endpoint answers with
// { isNewAccount, role }, so it remains an enumeration oracle. Gating
// (invite-only / admin-approved) is still required before this is hardened.
app.post('/api/auth/request-code', wrap(async (req) => {
  const email = await normalizeEmail(req.body.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new HttpError(400, 'Enter a valid email address');
  // The @applywizz.local fixture domain is permanently dead: those retired
  // test addresses (rakesh@, priya.cam@ and any other) can neither sign in nor
  // sign up, so reject them as invalid mail before any account lookup happens.
  if (isForbiddenLoginEmail(email)) throw new HttpError(400, 'Invalid mail: this address is retired and can no longer sign in or sign up.');
  const mode = String(req.body.mode || 'signup').toLowerCase() === 'signin' ? 'signin' : 'signup';

  let user = await findStaffByEmail(email);
  let isNewAccount = false;
  if (!user) {
    if (mode === 'signin') {
      throw new HttpError(404, 'No account found for that email. Switch to "Sign up" to create one.');
    }
    const role = await assertSignupRole({
      email,
      role: req.body.role,
      adminLookup: (await listStaff('admin')).some((a) => a.email === email)
    });
    let managerId = req.body.managerId || null;
    if (role === 'ca') {
      const opsList = await listStaff('ops');
      if (opsList.length && !managerId) throw new HttpError(400, 'Select your OM manager to complete sign-up');
      if (managerId && !opsList.some((o) => o.uuid === managerId)) throw new HttpError(400, 'Unknown OM manager');
    } else {
      managerId = null;
    }
    // No name field on the form any more: createStaff derives the display name
    // from the email address, and still honours `name` for API/ingest callers.
    user = await createStaff({ email, name: req.body.name, role, managerId });
    isNewAccount = true;
  } else if (mode === 'signup') {
    throw new HttpError(409, 'An account already exists for that email. Switch to "Sign in".');
  } else if (user.role === 'ca' && !user.manager_id && req.body.managerId) {
    await updateStaffManager(user.uuid, req.body.managerId);
    user = await getStaff(user.uuid);
  }

  // PASSWORDLESS (temporary): no one-time code is issued or mailed any more.
  // Clearing the email / sign-up gate above is enough, so we mint the session
  // right here and hand the token back — the portal drops the user straight onto
  // their dashboard, with no code entry and no server-console/terminal round-trip.
  const session = await createSession(user.uuid);
  await touchSignIn(user.uuid);
  await logLogin(user, isNewAccount ? 'signup' : 'signin');
  return {
    authenticated: true,
    token: session.token,
    isNewAccount,
    email: user.email,
    name: user.name,
    role: user.role,
    user: { uuid: user.uuid, email: user.email, name: user.name, role: user.role }
  };
}));

async function logLogin(user, kind) {
  await logEvent(null, kind, user.uuid, { email: user.email, role: user.role });
}

// LEGACY / unused by the portal now that sign-in is passwordless: kept only so
// any older caller still hits the dead-fixture guard. No code is issued, so a
// real verify here can only fail. Do not wire the UI back to this endpoint.
app.post('/api/auth/verify-code', wrap(async (req) => {
  const email = await normalizeEmail(req.body.email);
  if (isForbiddenLoginEmail(email)) throw new HttpError(400, 'Invalid mail: this address is retired and can no longer sign in or sign up.');
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

// The job links an operator provided for this CA's clients that are still pending
// (never auto-queued). Read-only visibility so the CA can see their assigned links.
app.get('/api/ca/pending-links', requireAuth, requireRole('ca'), wrap(async (req) => ({
  links: await listPendingLinksForCa(req.user.uuid)
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
  // A CLOSED / REMOVED posting is a terminal fact the scanner recorded on the link
  // row (with a proof screenshot). It is neither 'scanned' nor a retryable
  // 'unscanned' - the pane must show WHY there is nothing to fill. Only applies
  // while the link really has no inventory (a later force-scan that finds a form
  // clears it, so a link with fields is always 'scanned').
  let linkEvidence = null;
  try { linkEvidence = app_.link_evidence_json ? JSON.parse(app_.link_evidence_json) : null; } catch { linkEvidence = null; }
  const linkUnavailable = !linkFields.length
    && (app_.link_status === 'unavailable' || Boolean(linkEvidence?.reason || linkEvidence?.screenshot));
  const blocking = questions.filter((r) => !r.value && r.required && r.source !== 'not_applicable' && r.source !== 'stale');
  return {
    applicationId: app_.id,
    awlId: app_.awl_id,
    linkId: app_.link_id,
    scanned: linkFields.length > 0,
    // 'pre_scanning' | 'queued' | 'failed' tell the UI to wait, not to give up.
    // 'unavailable' tells it the posting itself is gone - stop waiting, show proof.
    scanState: linkUnavailable ? 'unavailable' : (linkFields.length ? 'scanned' : (inFlight || 'unscanned')),
    linkEvidence: linkUnavailable ? { ...(linkEvidence || {}), status: app_.link_status } : null,
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

// An OM sets one of their own CAs' applicant limit (default 25). DEV/ADMIN may
// set any CA. The cap is enforced per-CA at assignment, not on the manager.
app.post('/api/ops/ca/:uuid/quota', requireAuth, requireRole('ops', 'dev', 'admin'), wrap(async (req) => {
  const ca = await getStaff(req.params.uuid);
  if (!ca || ca.role !== 'ca') throw new HttpError(400, 'Target must be a CA');
  if (req.user.role === 'ops' && ca.manager_id !== req.user.uuid) {
    throw new HttpError(403, 'That CA is not under you');
  }
  return { staff: await updateStaffQuota(req.params.uuid, req.body.quota) };
}));

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
    cas: await Promise.all(cas.map(async (ca) => {
      const usage = await caQuotaUsage(ca.uuid);
      return {
        uuid: ca.uuid,
        name: ca.name,
        email: ca.email,
        active: !!ca.active,
        lastSignIn: ca.last_sign_in,
        applicantQuota: usage.quota,
        assignedApplicants: usage.assigned,
        applications: (await getApplications({ role: 'ca', uuid: ca.uuid })).length
      };
    })),
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
  // The single shared CA quota the DEV dashboard edits (no per-CA control there).
  caQuota: await getGlobalCaQuota(),
  system: {
    workerEnabled: await getSystemState('worker_enabled') === 'true',
    worker: await worker.workerStatus(),
    // Which variable NAMES arrived on THIS host, never their values. An
    // operator cannot shell into a Railway container, so the pane has to answer
    // "did my credentials actually reach the process" - 'not configured' with
    // the names it looked for is a diagnosis, a bare no is not.
    connector: describeConnectorEnv().summary,
    connectorPresent: describeConnectorEnv().present,
    connectorLooksFor: describeConnectorEnv().names,
    database: `OK (${db.backend === 'supabase' ? 'Supabase Postgres (shared)' : 'local SQLite'}) - host ${os.hostname()}`,
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
  if (!connectorConfigured()) throw new HttpError(400, `Postgres not configured on this host. ${describeConnectorEnv().summary}. Or use Ingest to load a JSON export.`);
  const sync = await syncFromPostgres({ opsId: req.body.opsId || null });
  // A sync can bring in links nobody has scanned yet — same rule as ingestion:
  // every assigned link must end up with a cached question inventory.
  // The CRM just repointed every resume_address at the S3 link; re-host the
  // copies into Supabase (best-effort) so the Railway worker can still fetch
  // them. A failure here is reported, never fatal to the sync.
  let resumes;
  try { resumes = await stageResumesForPending({}); }
  catch (err) { resumes = { error: String(err.message || err).slice(0, 200) }; }
  return { sync, scan: await queueUnscannedLinks('sync'), resumes };
}));


// Purge every staff fixture that is NOT a real @applywizz.com/.ai person. A
// full CRM /api/dev/sync already re-points applicants onto their real CA, so
// this is the cleanup that removes the leftover @applywizz.local admin/CA/OM/DEV
// rows. DRY RUN unless apply:true is sent: a dry run only reports the projected
// fate, it writes nothing. A doomed row that STILL owns unresolvable work or
// SUCCESS history is retired (active=0), never force-deleted, so no FK breaks.
app.post('/api/dev/staff/purge', requireAuth, requireRole('dev', 'admin'), wrap(async (req) => {
  const dryRun = req.body.apply !== true;
  const index = await buildAwlCaIndex();          // null when no CRM here
  const resolveApplicant = index
    ? async (app) => index.get(normalizeAwlId(app.awl_id)) || null
    : null;
  const report = await purgeLocalStaff({ resolveApplicant, dryRun, actor: req.user.uuid });
  // Finish the job: purgeLocalStaff only RETIRES a fixture still pinned by
  // SUCCESS history; this detaches those references and DELETES the dead
  // @applywizz.local rows for good (real @applywizz staff are never touched).
  const fixtures = await removeDeadFixtures({ dryRun, actor: req.user.uuid });
  return { report, fixtures };
}));

// Load one exported applicant document (the { client, additional_information } shape).
app.post('/api/dev/ingest', requireAuth, requireRole('dev', 'admin'), wrap(async (req) => {
  const ingest = await ingestDocument(req.body.doc || req.body, { opsId: req.body.opsId || null });
  return { ingest, scan: await queueUnscannedLinks('ingest') };
}));

// Refresh (or create) a single applicant straight from the CRM tables by
// AWL-ID — the one key that resolves every detail of any applicant.
app.post('/api/dev/sync-one', requireAuth, requireRole('dev', 'admin'), wrap(async (req) => {
  if (!connectorConfigured()) throw new HttpError(400, `Postgres not configured on this host. ${describeConnectorEnv().summary}.`);
  const awlId = String(req.body.awlId || req.body.awl_id || '').trim();
  if (!awlId) throw new HttpError(400, 'awlId is required');
  const sync = await syncApplicantByAwl(awlId, { opsId: req.body.opsId || null });
  let resumes;
  try { resumes = await stageResumeForAwl(awlId); }
  catch (err) { resumes = { error: String(err.message || err).slice(0, 200) }; }
  return { awlId, sync, scan: await queueUnscannedLinks('sync-one'), resumes };
}));

// (Re)mirror applicant resumes into Supabase Storage so the Railway worker can
// fetch them despite the S3 bucket refusing its egress IP. One AWL if awlId is
// given, else every candidate. force:true re-downloads even a cached copy.
app.post('/api/dev/resumes/stage', requireAuth, requireRole('dev', 'admin'), wrap(async (req) => {
  const awlId = String(req.body.awlId || req.body.awl_id || '').trim();
  const force = req.body.force === true;
  if (awlId) return { awlId, result: await stageResumeForAwl(awlId, { force }) };
  return { summary: await stageResumesForPending({ limit: Number(req.body.limit) || 500, force }) };
}));


// Rebuild the AWL-ID -> CA -> OM(CAM) org chart on demand: seed the committed
// roster as staff, then derive CA -> OM edges from clients_additional_info.
// Idempotent - safe to hit after any deploy or roster change. Returns the live
// directory health so the DEV pane can show real CAs/OPS/ADMIN counts.
app.post('/api/dev/staff/tree', requireAuth, requireRole('dev', 'admin'), wrap(async () => {
  const result = await buildStaffTree();
  return { ...result, stats: await staffDirectoryStats(), connector: connectorConfigured() };
}));
app.get('/api/dev/staff/tree', requireAuth, requireRole('dev', 'admin'), wrap(async () => ({
  stats: await staffDirectoryStats(), connector: connectorConfigured()
})));

/* ---------------- v3.7 CA work-history + ca_data + dynamic APIs ------ */

// Inclusive [from,to] day span: query wins, else the DEV-set default, else today.
function todayIso() { return new Date().toISOString().slice(0, 10); }
async function workHistorySpan(req) {
  const dFrom = await getSystemState('work_history_default_from', '');
  const dTo = await getSystemState('work_history_default_to', '');
  const from = String(req.query.from || req.body?.from || dFrom || todayIso());
  const to = String(req.query.to || req.body?.to || dTo || todayIso());
  return { from, to };
}

// The CAs whose work-history the caller may see: an OM sees only their tree, a
// DEV/ADMIN sees every active CA (optionally narrowed by ?managerId=).
async function scopedCas(req) {
  const allCa = (await listStaff('ca')).filter((c) => c.active);
  if (req.user.role === 'ops') return allCa.filter((c) => c.manager_id === req.user.uuid);
  const mgr = req.query.managerId;
  return mgr ? allCa.filter((c) => c.manager_id === mgr) : allCa;
}

// External API settings: DEV/ADMIN-only, kept in system_state so nothing is
// hardcoded or lives in .env; the connectors re-read them at call time.
app.get('/api/dev/settings/apis', requireAuth, requireRole('dev', 'admin'), wrap(async () => {
  const cfg = await extApiSettings();
  return {
    caMgmtBase: cfg.caMgmtBase,
    applywizzBase: cfg.applywizzBase,
    authHeader: cfg.authHeader,
    authValue: cfg.authValue
  };
}));

app.post('/api/dev/settings/apis', requireAuth, requireRole('dev', 'admin'), wrap(async (req) => {
  const b = req.body || {};
  await setSystemState(EXT_API_KEYS.caMgmtBase, String(b.caMgmtBase || '').trim());
  await setSystemState(EXT_API_KEYS.applywizzBase, String(b.applywizzBase || '').trim());
  await setSystemState(EXT_API_KEYS.authHeader, String(b.authHeader || '').trim());
  await setSystemState(EXT_API_KEYS.authValue, String(b.authValue || '').trim());
  clearExtApiCache();
  const cfg = await extApiSettings();
  return { ok: true, caMgmtBase: cfg.caMgmtBase, applywizzBase: cfg.applywizzBase, authHeader: cfg.authHeader };
}));

// Connectivity probe against the CURRENT saved settings (never saves anything).
app.post('/api/dev/settings/apis/test', requireAuth, requireRole('dev', 'admin'), wrap(async (req) => {
  const which = String(req.body?.which || 'ca_emails');
  try {
    if (which === 'work_history') {
      const { from, to } = await workHistorySpan(req);
      const r = await workHistory({ caEmail: req.body?.caEmail, from, to });
      if (r.skipped) return { ok: false, skipped: r.skipped };
      return { ok: r.ok, sample_count: r.records.length, total: r.total };
    }
    if (which === 'client_details') {
      const r = await clientDetails(req.body?.awlId || 'AWL-35186');
      if (r.skipped) return { ok: false, skipped: r.skipped };
      return { ok: r.ok, sample: Boolean(r.data) };
    }
    const r = await caEmails();
    if (r.skipped) return { ok: false, skipped: r.skipped };
    return { ok: r.ok, sample_count: r.count };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}));

// On-demand refresh: rebuild ca_data (visibility-only assignment) then pull the
// external work-history for the span. Never calls queueUnscannedLinks.
app.post('/api/dev/ca-data/refresh', requireAuth, requireRole('dev', 'admin'), wrap(async (req) => {
  const { from, to } = await workHistorySpan(req);
  const dryRun = req.body?.dryRun === true;
  const caData = await buildCaData({ dryRun, actor: req.user.uuid });
  const wh = dryRun ? { skipped: 'dry_run' } : await refreshWorkHistory({ from, to });
  return { from, to, caData, workHistory: wh, stats: await caDataStats() };
}));

// CA capacity over a span, scoped to the caller's tree.
app.get('/api/work-history', requireAuth, requireRole('ops', 'dev', 'admin'), wrap(async (req) => {
  const { from, to } = await workHistorySpan(req);
  const cas = await scopedCas(req);
  const agg = await getCaWorkHistory(cas.map((c) => c.uuid), from, to);
  const byUuid = new Map(cas.map((c) => [c.uuid, c]));
  const omName = new Map((await listStaff('ops')).map((o) => [o.uuid, o.name]));
  const rows = agg.map((a) => {
    const s = byUuid.get(a.caId) || {};
    const omId = a.omId || s.manager_id || null;   // cached edge, else the live staff manager
    return {
      ca: { uuid: a.caId, name: s.name, email: s.email },
      awls: a.awls, awlIds: a.awlIds, jobsApplied: a.jobsApplied, byStatus: a.byStatus,
      live: a.live, lastEnd: a.lastEnd, omId, omName: omName.get(omId) || null
    };
  }).sort((x, y) => y.jobsApplied - x.jobsApplied);
  const omsSeen = new Map();
  for (const r of rows) if (r.omId) omsSeen.set(r.omId, r.omName || r.omId);
  return {
    from, to,
    summary: {
      cas: rows.length,
      liveCas: rows.filter((c) => c.live).length,
      clients: rows.reduce((s, c) => s + (c.awls || 0), 0),
      jobsApplied: rows.reduce((s, c) => s + (c.jobsApplied || 0), 0),
    },
    oms: [...omsSeen.entries()].map(([id, name]) => ({ id, name })).sort((a, b) => String(a.name).localeCompare(String(b.name))),
    cas: rows
  };
}));

// A CA's AWL stack in the span + any locally-applied detail. OM restricted to own tree.
app.get('/api/work-history/ca/:uuid', requireAuth, requireRole('ops', 'dev', 'admin'), wrap(async (req) => {
  if (req.user.role === 'ops') {
    const caRow = await getStaff(req.params.uuid);
    if (!caRow || caRow.role !== 'ca' || caRow.manager_id !== req.user.uuid) throw new HttpError(403, 'That CA is not under you');
  }
  const { from, to } = await workHistorySpan(req);
  const ca = await getStaff(req.params.uuid);
  return { from, to, ca: ca ? { uuid: ca.uuid, name: ca.name, email: ca.email } : null, awls: await getCaWorkHistoryDetail(req.params.uuid, from, to) };
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
// route is the write side: whatever DEV uploads as a .csv or pastes as text is
// appended to that same table (so it survives a re-sync and stays visible to the
// user), mirrored into the pending applicant_joblinks rows, and the link itself
// is registered in public.ashby_joblink_questions, which holds its pre-scanned
// questions. From there the pre-scan worker takes over on its own.
function parseLinkPairs(body = {}) {
  const out = [];
  for (const p of (Array.isArray(body.pairs) ? body.pairs : [])) {
    out.push({
      awlId: normalizeAwlId(p.awlId || p.awl_id || p.awl),
      url: String(p.url || p.job_link || p.link || '').trim(),
      company: String(p.company || '').trim(),
      title: String(p.title || '').trim()
    });
  }
  // ONE parser for both a pasted block and an uploaded .csv (core/joblink-csv.js):
  // header row matched by name, quoted cells honoured, TSV/;/| delimiters detected,
  // and a header-less line still resolves because the AWL-ID + URL are matched by
  // shape instead of trusting a column order. `malformed` is what the DEV sees as
  // "these rows were not pairs" rather than the ingest quietly dropping them.
  const table = parseAwlLinkTable(body.text || '');
  out.push(...table.pairs);
  const single = {
    awlId: normalizeAwlId(body.awlId),
    url: String(body.url || '').trim(),
    company: String(body.company || '').trim(),
    title: String(body.title || '').trim()
  };
  if (single.awlId && single.url) out.push(single);
  return { pairs: out.filter((p) => p.awlId && p.url), malformed: table.skipped };
}

app.post('/api/dev/links', requireAuth, requireRole('dev', 'admin'), wrap(async (req) => {
  const { pairs, malformed } = parseLinkPairs(req.body || {});
  if (!pairs.length) {
    throw new HttpError(400, malformed.length
      ? `Nothing usable in that input: ${malformed.length} row(s) had no AWL-ID + job link pair (first: line ${malformed[0].line} — ${malformed[0].reason}).`
      : 'No (AWL-ID, job link) pairs found. Upload a .csv with an AWL-ID and a job link column, or paste lines like: AWL-12  https://jobs.ashbyhq.com/…');
  }
  const seen = new Set();
  const accepted = [];
  const rejected = [];
  const placeholders = [];
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
  for (const { awlId, url, company, title } of pairs) {
    const dedupe = `${awlId}|${normalizeJobLink(url)}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    let applicant = await getApplicantByAwlId(awlId);
    if (connectorConfigured() && (!applicant || !applicant.ca_id)) {
      // Unknown AWL, or a previously-orphaned shell with no CA: pull it straight
      // from the CRM so the CA mapping is applied instead of leaving the row
      // invisible to every CA. Re-ingesting an AWL must be able to repair it.
      await syncApplicantByAwl(awlId).catch(() => {});
      applicant = await getApplicantByAwlId(awlId);
    }
    if (!applicant) {
      // Operator rule for table ingest: a row the CRM does not know yet is still
      // an assignment, so create the shell applicant rather than dropping the
      // link. The assignment + pre-scan happen now; the real details arrive on
      // the next sync (or the run's own re-fetch by AWL-ID), and until then the
      // draft pass simply has nothing to answer from and asks the CA.
      applicant = (await upsertExternalApplicant({
        awlId, fullName: awlId, email: '', phone: '', resumeAddress: '', profileJson: '{}', extId: null, opsId: null
      })).applicant;
      placeholders.push(awlId);
      // connector_configured is the difference between "the CRM does not know
      // this person yet" and "this host was never allowed to look". AWL-25663
      // was a shell of the second kind, and the feed could not tell them apart.
      await logEvent(null, 'applicant_placeholder_created', 'dev', { awl_id: awlId, source: 'link_ingest', connector_configured: connectorConfigured() });
    }
    // 1. remember the assignment in the CRM map (awl_id -> job_links[])
    const stored = await appendJobLink(awlId, url);
    // 2. queue it locally as a pending link
    await upsertApplicantJoblink(awlId, { url, company: company || '', title: title || '' });
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
  // Surface (never silently) any AWL that still has no CA after all of this: it
  // is invisible to every CA dashboard, so the operator is told here and can fix
  // it from DEV > Assignment health. The gap names the cause.
  const unassigned = [];
  for (const awlId of [...new Set(accepted.map((a) => a.awlId))]) {
    const ap = await getApplicantByAwlId(awlId);
    if (!ap || !ap.ca_id) {
      const d = unassigned.length < 25
        ? await diagnoseAssignment(awlId).catch(() => ({ gap: 'unknown' }))
        : { gap: 'unknown' };
      unassigned.push({ awlId, gap: d.gap || 'unknown' });
    }
  }
  // 4. pre-scan what has no questions yet — a durable background queue, one
  // browser at a time, so the paste returns immediately and the CA finds the
  // inventory (already answered as far as the applicant's data allows) waiting.
  const scan = needScan.size ? await enqueueLinkScans([...needScan], { reason: 'links_ingested' })
    : { enabled: true, queued: [], skipped: [] };
  const failed = accepted.filter((a) => a.error);
  return {
    accepted: accepted.filter((a) => !a.error), rejected: [...rejected, ...failed],
    links: accepted.map((a) => a.url), profiles, scan,
    unassigned,
    // Whether THIS host can read the CRM at all. False means every AWL-ID here
    // became a shell and no run on it can fetch a resume, so the UI has to say
    // that instead of promising a later sync.
    connector: connectorConfigured(),
    // Rows the parser could not read as a pair, plus the AWL-IDs it had to
    // create a shell for - both need to be visible, never silently dropped.
    placeholders: [...new Set(placeholders)],
    malformed: malformed.slice(0, 50), malformed_count: malformed.length
  };
}));

/* ------------------ assignment health (the invisible-applicant net) ------------------
   An applicant whose ca_id is NULL is invisible to EVERY CA dashboard, yet the
   ingest that created it reported "accepted". This is the systemic backstop: the
   DEV view lists every such applicant, and the resolve action re-syncs each from
   the CRM (the source of truth) and reports exactly why any still cannot be
   assigned. It NEVER invents a CA or a staff row - an AWL the CRM does not know
   stays flagged, it is not silently dropped or guessed. */
app.get('/api/dev/assignment-health', requireAuth, requireRole('dev', 'admin'), wrap(async () => {
  const rows = await listUnassignedApplicants();
  return {
    connector: connectorConfigured(),
    count: rows.length,
    with_links: rows.filter((a) => Number(a.pending_links) > 0).length,
    unassigned: rows.map((a) => ({
      awlId: a.awl_id, fullName: a.full_name, email: a.email,
      pendingLinks: Number(a.pending_links) || 0,
      // coarse hint from our own rows; the authoritative gap comes from resolve
      hint: a.ext_id ? 'ca_not_rostered' : (a.full_name === a.awl_id ? 'shell' : 'unassigned'),
    })),
  };
}));

app.post('/api/dev/assignment-health/resolve', requireAuth, requireRole('dev', 'admin'), wrap(async (req) => {
  if (!connectorConfigured()) {
    throw new HttpError(400, 'This host cannot reach the CRM, so assignment cannot be resolved here. Run it from a CRM-connected host.');
  }
  const only = normalizeAwlId(req.body?.awlId || '');
  const targets = only ? [{ awl_id: only }] : await listUnassignedApplicants();
  const results = [];
  for (const row of targets) {
    const awlId = row.awl_id;
    if (!awlId) continue;
    let outcome;
    try {
      await syncApplicantByAwl(awlId);                       // CRM is authoritative; repairs the shell
      const ap = await getApplicantByAwlId(awlId);
      if (ap?.ca_id) {
        const ca = await getStaff(ap.ca_id);
        outcome = { awlId, result: 'assigned', caId: ap.ca_id, caName: ca?.name || ca?.email || ap.ca_id };
      } else {
        const d = await diagnoseAssignment(awlId);           // why it still has no CA
        outcome = { awlId, result: 'unassigned', gap: d.gap || 'unknown', caExtId: d.caExtId || null };
      }
    } catch (err) {
      outcome = { awlId, result: 'error', error: String(err.message || err).slice(0, 200) };
    }
    results.push(outcome);
    await logEvent(null, 'assignment_resolved', 'dev', { awl_id: awlId, ...outcome });
  }
  const assigned = results.filter((r) => r.result === 'assigned').length;
  await logEvent(null, 'assignment_health_resolve', 'dev', { attempted: results.length, assigned });
  return { attempted: results.length, assigned, results };
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

// The DEV single CA quota block: one value (a number, or null/"none" = No limit)
// applied to EVERY existing CA at once, so all CAs share the same cap.
app.post('/api/dev/ca-quota/global', requireAuth, requireRole('dev', 'admin'), wrap(async (req) => ({
  global: await setGlobalCaQuota(req.body.quota)
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
