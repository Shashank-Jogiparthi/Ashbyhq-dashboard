/* =====================================================================
   PARALLEL AUTOMATION RUNNER
   Every application the CA moves to QUEUED is executed by launching the
   proven base-layer engine (ashby-hybrid-automation.js) as an ISOLATED
   child process with its own browser + own APPLICANT_DATA_DIR. That is
   true concurrency: N CAs clicking APPLY at once => N browsers running
   simultaneously, no queue, no shared state. A bounded semaphore keeps
   the machine from drowning; QUEUED rows past the cap simply wait for
   the next free slot (still picked up live by the poll loop).

   Result mapping (read from the engine's job-status JSON after close):
     success        -> SUCCESS
     failed         -> FAILED   (validation banner captured as reason)
     unknown        -> PENDING  (submitted, acknowledgement unclear)
     manual-review  -> PENDING  (no submit button; needs a human)
     crash / no-outcome -> FAILED (engine crashed)
   ===================================================================== */
import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { ROOT_DIR } from '../db/index.js';
import {
  listQueuedForWorker, claimForRun, finishRun, markRunCrash,
  getSystemState, logEvent, listFieldAnswers,
  recordSubmitMissingFields, reopenForMissingFields,
  getApplicationById, purgeApplicantFormData
} from '../db/store.js';

const WORKSPACE_ROOT = path.resolve(ROOT_DIR, '..');
const ENGINE_PATH = process.env.ENGINE_PATH
  || path.join(WORKSPACE_ROOT, 'ashby-hybrid-automation.js');
const MAX_CONCURRENT = Math.max(1, Number(process.env.MAX_CONCURRENT_RUNS || 4));
const POLL_MS = Math.max(2000, Number(process.env.WORKER_POLL_MS || 8000));
// Runs use an OS temp dir OUTSIDE the repo so no applicant artefact (profile,
// answers, downloaded resume, engine job-status JSON, screenshots) ever lands
// in the working tree. The whole per-run dir is deleted the moment the run
// finishes; the only durable record is the text status/reason in Supabase.
const RUNS_DIR = process.env.RUN_TMP_DIR || path.join(os.tmpdir(), 'applywizz-runs');

const active = new Set();          // application ids in flight
let pollTimer = null;
let started = false;

export async function workerStatus() {
  return {
    started,
    active: active.size,
    maxConcurrent: MAX_CONCURRENT,
    engine: fs.existsSync(ENGINE_PATH) ? ENGINE_PATH : 'MISSING',
    enabled: await getSystemState('worker_enabled') === 'true'
  };
}

export async function start() {
  if (started) return workerStatus();
  started = true;
  fs.mkdirSync(RUNS_DIR, { recursive: true });
  pollTimer = setInterval(() => { tick().catch((e) => console.error('worker tick:', e.message)); }, POLL_MS);
  console.log(`Worker started (max ${MAX_CONCURRENT} concurrent browsers, poll ${POLL_MS}ms).`);
  tick();
  return workerStatus();
}

export async function stop() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = null;
  started = false;
  console.log('Worker stopped (no new runs will be claimed).');
  return workerStatus();
}

// Called right after a CA clicks APPLY so a run begins immediately rather
// than waiting for the next poll tick.
export function kick() { tick().catch((e) => console.error('worker kick:', e.message)); }

async function tick() {
  if (await getSystemState('worker_enabled') !== 'true') return;
  const free = MAX_CONCURRENT - active.size;
  if (free <= 0) return;
  const queued = (await listQueuedForWorker()).filter((a) => !active.has(a.id));
  // Fire each launch without awaiting: awaiting serialises the browsers, which
  // is exactly what the concurrency budget exists to avoid. Keep a catch so a
  // rejected launch never becomes an unhandled rejection.
  for (const app of queued.slice(0, free)) launch(app).catch((e) => console.error('launch:', e.message));
}

async function launch(app) {
  const runId = `${Date.now()}-${app.id}`;
  const runDir = path.join(RUNS_DIR, runId);
  const storeDir = path.join(runDir, 'store');
  fs.mkdirSync(storeDir, { recursive: true });

  const claimed = await claimForRun(app.id, runId);
  if (!claimed) return;              // another slot grabbed it
  active.add(app.id);

  // A previous SUCCESS (or a fresh assignment the CRM had not been read for)
  // can leave this applicant with no snapshot. Fix that before spending a
  // browser: the AWL-ID alone resolves everything from the two CRM tables.
  await ensureApplicantSnapshot(app);

  const profileFile = path.join(runDir, 'profile.json');
  try {
    fs.writeFileSync(profileFile, app.profile_json || '{}', 'utf8');
  } catch { /* non-fatal */ }

  // Confirmed pre-Apply answers (draft + CA review) are the authoritative
  // source at submit. Hand the child the answered rows so the engine replays
  // them onto the live form instead of re-guessing from the resume alone.
  const answersFile = path.join(runDir, 'answers.json');
  try {
    const answers = (await listFieldAnswers(app.awl_id, app.link_id))
      .filter((r) => r.value != null && String(r.value).trim() !== '')
      .map((r) => ({
        field_key: r.field_key,
        question_text: r.question_text,
        field_type: r.field_type,
        options: r.options,
        value: r.value
      }));
    fs.writeFileSync(answersFile, JSON.stringify(answers), 'utf8');
  } catch { /* non-fatal: engine falls back to live matching */ }

  await logEvent(app.id, 'run_started', 'worker', { run_id: runId, url: app.url });

  const finish = async () => {
    active.delete(app.id);
    let outcome = 'failed';
    let reason = 'Engine process exited without a result';
    let missingFields = [];
    const result = readLatestResult(storeDir);
    if (result) {
      const status = String(result.applicationStatus || result.status || '').toLowerCase();
      if (status === 'success') outcome = 'success';
      else if (status === 'failed') { outcome = 'failed'; reason = result.bannerText || result.reason || 'Validation error'; }
      else if (status === 'unknown' || status === 'manual-review' || status === 'pending') { outcome = 'pending'; reason = status === 'manual-review' ? 'No submit button (manual review)' : 'Outcome unclear'; }
      if (Array.isArray(result.missingFields)) missingFields = result.missingFields;
    }
    // Two evidence screenshots are captured per run: #1 the fully-filled form
    // BEFORE Submit, #2 the post-submit acknowledgement. They live only in the
    // temp dir, so upload them to Supabase Storage now (before cleanup) and
    // persist just the public URLs. If Storage is not configured the reason is
    // recorded instead — nothing applicant-related is ever kept on disk.
    const shots = await persistScreenshots(app, runId, result);
    try {
      await finishRun(app.id, outcome, { screenshot_path: shots.acknowledgementUrl, screenshots_json: shots.json, reason });
      await logEvent(app.id, `run_${outcome}`, 'worker', { run_id: runId, reason: reason || null, missing_fields: missingFields, screenshots: shots.meta });
      // Re-loop: if the run failed because required fields were still blank, the
      // automation had no data to fill them. Surface those exact questions to the
      // CA as blockers and reopen the application to ASSIGNED, so the next apply
      // cannot proceed until the CA answers them (APPLY is gated on blockers==0).
      if (outcome === 'failed' && missingFields.length) {
        const added = await recordSubmitMissingFields(app.awl_id, app.link_id, missingFields);
        if (added) await reopenForMissingFields(app.id, `Missing required field(s): ${missingFields.join('; ')}`);
      }
      // SUCCESS (never a missing-field failure): push the finalized submission
      // back into the CRM as the durable copy, then erase this applicant's form
      // data from the working cache. What survives here is exactly what the
      // platform needs afterwards: status, failure reason, screenshot URLs.
      if (outcome === 'success') {
        const writeback = await writeBackFinalized(app);
        const purge = await purgeSuccessful(app);
        await logEvent(app.id, 'applicant_data_purged', 'worker', { writeback, ...purge });
      }
    } catch (err) {
      try { await markRunCrash(app.id, `Result mapping failed: ${err.message}`); } catch { /* ignore */ }
    }
    cleanupRun(runDir);
  };

  (async () => {
    let resumePath = null;
    try {
      resumePath = await resolveResume(app.resume_address, runDir);
    } catch (err) {
      active.delete(app.id);
      try { await markRunCrash(app.id, `Resume unavailable: ${err.message}`); } catch { /* ignore */ }
      return;
    }

    const child = spawn(process.execPath, [ENGINE_PATH, app.url, resumePath], {
      cwd: WORKSPACE_ROOT,
      windowsHide: true,
      env: {
        ...process.env,
        APPLICANT_ID: app.awl_id,
        PERSON_PROFILE_PATH: profileFile,
        APPLICANT_DB_PATH: profileFile,
        FIELD_ANSWERS_PATH: answersFile,
        APPLICANT_DATA_DIR: storeDir
      }
    });
    child.stdout.on('data', (d) => process.stdout.write(`[run ${app.id}] ${d}`));
    child.stderr.on('data', (d) => process.stderr.write(`[run ${app.id}!] ${d}`));
    child.on('close', () => finish());
    child.on('error', async (err) => {
      active.delete(app.id);
      try { await markRunCrash(app.id, `Spawn error: ${err.message}`); } catch { /* ignore */ }
      cleanupRun(runDir);
    });
  })();
}

/* ------------------------------ helpers ----------------------------- */

// Load the merged CRM profile into `app` in place when it is missing/empty.
// Never throws: with no CRM configured the run proceeds on whatever is stored.
async function ensureApplicantSnapshot(app) {
  const raw = String(app.profile_json || '').trim();
  if (raw && raw !== '{}') return false;
  try {
    const { isConfigured, syncApplicantByAwl } = await import('../connector/applicant-db.js');
    if (!isConfigured()) return false;
    await syncApplicantByAwl(app.awl_id);
    const fresh = await getApplicationById(app.id);
    if (fresh) Object.assign(app, fresh);
    await logEvent(app.id, 'applicant_profile_refetched', 'worker', { awl_id: app.awl_id });
    return true;
  } catch (err) {
    await logEvent(app.id, 'applicant_profile_refetch_failed', 'worker', { error: String(err.message || err).slice(0, 200) });
    return false;
  }
}

// Post-SUCCESS erase. Answers for this (applicant, link) always go; the shared
// profile blob goes only if the store says nothing else is open for them.
async function purgeSuccessful(app) {
  try {
    const r = await purgeApplicantFormData(app.awl_id, app.link_id, app.id);
    return { answers_removed: r.answersRemoved, profile_cleared: r.profileCleared };
  } catch (err) {
    return { error: String(err.message || err).slice(0, 200) };
  }
}

// Upload the run's pre-submit + acknowledgement screenshots (temp paths from
// the engine result) to Supabase Storage and return the URLs to persist.
// Never throws: a storage problem only means we record why and keep nulls.
async function persistScreenshots(app, runId, result) {
  const prePath = result && result.preSubmitScreenshot;
  const ackPath = result && result.screenshot;
  const out = { acknowledgementUrl: null, json: null, meta: { captured: Boolean(prePath || ackPath) } };
  if (!prePath && !ackPath) return out;   // nothing captured (e.g. crash before submit)
  // The two shots the platform promises: the filled form BEFORE the
  // "Submit Application" click and the acknowledgement AFTER it.
  await logEvent(app.id, 'screenshots_captured', 'worker', {
    run_id: runId, pre_submit: Boolean(prePath), after_submit: Boolean(ackPath)
  });
  try {
    const { uploadScreenshot, storageConfigured } = await import('../connector/supabase-storage.js');
    if (!storageConfigured()) {
      out.json = JSON.stringify({ error: 'storage_not_configured' });
      out.meta.stored = false; out.meta.reason = 'storage_not_configured';
      await logEvent(app.id, 'screenshots_upload_failed', 'worker', { run_id: runId, error: 'storage_not_configured (SUPA_S3_* / SUPA_SERVICE_KEY missing)' });
      return out;
    }
    const base = `${app.awl_id}/${app.link_id}/${runId}`;
    const pre = prePath ? await uploadScreenshot({ filePath: prePath, destPath: `${base}-pre-submit.png` }) : { ok: false, skipped: 'not_captured' };
    const ack = ackPath ? await uploadScreenshot({ filePath: ackPath, destPath: `${base}-acknowledgement.png` }) : { ok: false, skipped: 'not_captured' };
    out.acknowledgementUrl = ack.ok ? ack.url : null;
    const payload = { pre_submit: pre.ok ? pre.url : null, acknowledgement: ack.ok ? ack.url : null };
    const errs = [];
    if (prePath && !pre.ok) errs.push(`pre_submit: ${pre.error || pre.skipped}`);
    if (ackPath && !ack.ok) errs.push(`acknowledgement: ${ack.error || ack.skipped}`);
    if (errs.length) payload.error = errs.join('; ');
    out.json = JSON.stringify(payload);
    out.meta.stored = Boolean(payload.pre_submit || payload.acknowledgement);
    out.meta.error = payload.error || null;
    // The S3 addresses are the durable evidence trail, so the DEV sees them live
    // in the activity feed instead of having to open the applications row.
    await logEvent(app.id, errs.length ? 'screenshots_upload_failed' : 'screenshots_uploaded', 'worker', {
      run_id: runId, path: `${app.awl_id}/${app.link_id}/${runId}`, ...payload
    });
    return out;
  } catch (err) {
    out.json = JSON.stringify({ error: err.message });
    out.meta.stored = false; out.meta.reason = err.message;
    await logEvent(app.id, 'screenshots_upload_failed', 'worker', { run_id: runId, error: String(err.message || err).slice(0, 200) });
    return out;
  }
}

// Read the finalized (CA-confirmed) answers back from Supabase and mirror the
// successful application into the external CRM. Kept out of the hot path and
// fully error-contained: a failed write-back only logs, never changes status.
async function writeBackFinalized(app) {
  try {
    const { persistFinalizedToExternal } = await import('../connector/applicant-db.js');
    const answers = (await listFieldAnswers(app.awl_id, app.link_id))
      .filter((r) => r.value != null && String(r.value).trim() !== '')
      .map((r) => ({ field_key: r.field_key, question_text: r.question_text, source: r.source, value: r.value }));
    let profile = {};
    try {
      profile = JSON.parse(app.profile_json || '{}');
      delete profile.raw; // don't ship the heavy raw blob back to the CRM
    } catch { /* keep empty */ }
    const res = await persistFinalizedToExternal({
      awlId: app.awl_id, url: app.url, company: app.company, title: app.title,
      status: 'SUCCESS', profile, answers, resumeAddress: app.resume_address
    });
    await logEvent(app.id, 'crm_writeback', 'worker', res);
    return res;
  } catch (err) {
    try { await logEvent(app.id, 'crm_writeback', 'worker', { ok: false, error: err.message }); } catch { /* ignore */ }
    return { ok: false, error: String(err.message || err).slice(0, 200) };
  }
}

async function resolveResume(address, runDir) {
  const value = String(address || '').trim();
  if (!value) throw new Error('no resume address');
  if (/^https?:\/\//i.test(value)) {
    const dest = path.join(runDir, 'resume-download');
    const res = await fetch(value);
    if (!res.ok) throw new Error(`download ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    const file = `${dest}.pdf`;
    fs.writeFileSync(file, buf);
    return file;
  }
  if (fs.existsSync(value)) return value;
  throw new Error(`resume not found at ${value}`);
}

function readLatestResult(storeDir) {
  let newest = null;
  let newestTime = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.json') && full.includes(`${path.sep}jobs${path.sep}`)) {
        try {
          const data = JSON.parse(fs.readFileSync(full, 'utf8'));
          const t = Date.parse(data.updatedAt || data.createdAt || 0) || fs.statSync(full).mtimeMs;
          if (t >= newestTime) { newestTime = t; newest = data; }
        } catch { /* ignore malformed */ }
      }
    }
  };
  walk(storeDir);
  return newest;
}

// Nothing about an applicant run is left on disk: remove the entire temp run
// directory (profile, answers, downloaded resume, engine store + screenshots).
function cleanupRun(runDir) {
  try { fs.rmSync(runDir, { recursive: true, force: true }); } catch { /* ignore */ }
}
