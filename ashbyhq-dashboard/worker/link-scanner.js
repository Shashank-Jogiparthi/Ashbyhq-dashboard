/* =====================================================================
   LINK PRE-SCAN WORKER

   The rule it enforces: the moment a job link is assigned to ANY applicant,
   its question inventory must exist in public.ashby_joblink_questions — before
   a CA ever opens the review pane.

   It is a WORKER, not a promise. Every intent to scan is a row in
   `link_scan_jobs` (UNIQUE per canonical URL, so 7 applicants on one link
   still produce one scan), and the loop claims rows the same way the apply
   worker claims applications:

     enqueue  -> PENDING      (durable: survives a restart, dedupes itself)
     claim    -> RUNNING      (single-row CAS, two servers cannot both take it)
     ok       -> DONE         (+ optional draft pre-warm, see below)
     failure  -> PENDING again with exponential backoff, up to max_attempts,
                 then FAILED so a human sees it in the DEV pane
     died     -> RUNNING rows older than STALE_MS are handed back automatically

   After a scan lands, the worker runs the pre-Apply DRAFT PASS for every
   ASSIGNED/QUEUED application on that link (deterministic profile lookup ->
   GenAI for descriptive fields -> 'missing_fact' for real gaps). So the CA does
   not open an empty review pane and wait: the questions are already answered as
   far as the applicant's data allows, and only the unknowns are left to them.

   Scanning is headless by default (SCAN_HEADLESS) because a background worker
   that steals your screen every time a link is pasted is unusable. The APPLY
   path stays headed — that is where anti-spam behaviour matters.

   Kill switch: AUTO_SCAN_ON_LINK=false leaves the queue draining nothing, and
   `node scripts/scan-link.js <url>` still works by hand.
   ===================================================================== */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { canonicalJobUrl } from '../core/job-url.js';
import {
  enqueueScanJobs, claimNextScanJob, finishScanJob, markScanJobDuration,
  requeueStaleScanClaims, listScanJobs, scanJobCounts, getScanJobByUrl,
  getJobLinkByUrl, listApplicationsOnLink, logEvent
} from '../db/store.js';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD = path.resolve(HERE, '..');
const SCANNER = path.join(DASHBOARD, 'scripts', 'scan-link.js');

const TIMEOUT_MS = Math.max(60_000, Number(process.env.SCAN_TIMEOUT_MS || 15 * 60 * 1000));
const POLL_MS = Math.max(3000, Number(process.env.SCAN_POLL_MS || 8000));
const MAX_SCAN = Math.max(1, Number(process.env.SCAN_CONCURRENCY || 1));
const CLAIMER = `${os.hostname()}:${process.pid}`;
// A claim is presumed dead only after its own timeout could have elapsed.
const STALE_MS = TIMEOUT_MS + 120_000;

let timer = null;
let started = false;
const inFlight = new Map();          // url -> { jobId, startedAt, child }
const listeners = new Set();

export function autoScanEnabled() {
  return String(process.env.AUTO_SCAN_ON_LINK ?? 'true').toLowerCase() !== 'false';
}
export function draftPrewarmEnabled() {
  return String(process.env.SCAN_PREWARM_DRAFTS ?? 'true').toLowerCase() !== 'false'
    && String(process.env.DRAFT_ON_SCAN ?? 'true').toLowerCase() !== 'false';
}

function log(...parts) { console.log('[scan-worker]', ...parts); }
function note(event, payload) {
  for (const fn of listeners) { try { fn(event, payload); } catch { /* observer only */ } }
}
export function onScanEvent(fn) { listeners.add(fn); return () => listeners.delete(fn); }

/* ------------------------------- queueing ---------------------------- */

/**
 * Record the intent to pre-scan these links. Never throws; returns what it did
 * so the HTTP caller can report it. Kicks the loop so a fresh paste is picked
 * up immediately instead of on the next poll tick.
 */
export async function enqueueLinkScans(urls = [], { reason = 'ingest', force = false } = {}) {
  const skipped = [];
  const valid = [];
  for (const raw of [].concat(urls)) {
    const url = canonicalJobUrl(String(raw ?? '').trim());
    if (!url) continue;
    if (!/^https?:\/\//i.test(url)) { skipped.push({ url, why: 'not_a_url' }); continue; }
    valid.push(url);
  }
  if (!autoScanEnabled()) {
    return { enabled: false, queued: [], skipped: valid.map((url) => ({ url, why: 'auto_scan_disabled' })).concat(skipped) };
  }
  let res;
  try {
    res = await enqueueScanJobs(valid, { reason, force });
  } catch (err) {
    log('enqueue failed:', err.message);
    return { enabled: true, queued: [], skipped: valid.map((url) => ({ url, why: 'queue_unavailable' })).concat(skipped), error: err.message };
  }
  if (res.queued.length) {
    log(`queued ${res.queued.length} link(s) (${reason})`);
    note('queued', { queued: res.queued, reason });
    kick();
  }
  return { enabled: true, ...res, skipped: res.skipped.concat(skipped) };
}

/* ------------------------------- the loop ---------------------------- */

export function start() {
  if (started) return status();
  started = true;
  timer = setInterval(() => { tick().catch((e) => log('tick:', e.message)); }, POLL_MS);
  // Anything this process (or a dead one) left mid-flight goes back to the queue.
  requeueStaleScanClaims(STALE_MS).then((n) => { if (n) log(`recovered ${n} stale claim(s)`); })
    .catch((e) => log('stale sweep:', e.message));
  tick().catch((e) => log('first tick:', e.message));
  log(`started (max ${MAX_SCAN} concurrent, poll ${POLL_MS}ms, headless ${process.env.SCAN_HEADLESS === 'false' ? 'off' : 'on'}).`);
  return status();
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  started = false;
  log('stopped (in-flight scans finish, nothing new is claimed).');
  return status();
}

export function kick() { tick().catch((e) => log('kick:', e.message)); }

async function tick() {
  if (!autoScanEnabled() || inFlight.size >= MAX_SCAN) return;
  try { await requeueStaleScanClaims(STALE_MS); } catch { /* non-fatal */ }
  let job;
  try {
    job = await claimNextScanJob({ claimer: CLAIMER });
  } catch (err) {
    log('claim failed:', err.message);
    return;
  }
  if (!job) return;
  inFlight.set(job.url, { jobId: job.id, startedAt: Date.now(), child: null });
  note('start', { url: job.url, attempt: job.attempts });
  await logEvent(null, 'link_scan_start', 'scan-worker', { url: job.url, attempt: job.attempts, reason: job.reason });
  run(job).catch((e) => log('run:', e.message));
}

async function run(job) {
  const url = job.url;
  const outcome = await runScanner(url);
  const finishedAt = Date.now();
  const durationMs = finishedAt - (inFlight.get(url)?.startedAt || finishedAt);
  inFlight.delete(url);

  // scan-link.js reports its tier in one of three phrasings; the field count is
  // what the DEV table shows, so grab it whichever way it was written.
  const fields = Number(String(outcome.out || '').match(/(?:Stored|Restored|Already scanned:)\D*(\d+)\s*field/)?.[1] || 0);
  const ok = outcome.exitCode === 0 && !outcome.timedOut && !outcome.spawnError;
  const errorText = outcome.timedOut ? `timed out after ${Math.round(TIMEOUT_MS / 60000)}m`
    : outcome.spawnError || (outcome.tail || '').split('\n').filter(Boolean).slice(-1)[0] || `exit ${outcome.exitCode}`;

  try {
    const state = await finishScanJob(job.id, { ok, fields, error: ok ? null : errorText, maxAttempts: job.max_attempts, attempts: job.attempts });
    await markScanJobDuration(job.id, durationMs);

    if (ok) {
      const warmed = await prewarmDrafts(url);
      await logEvent(null, 'link_scan_done', 'scan-worker', {
        url, fields, seconds: Math.round(durationMs / 1000), attempt: job.attempts, prewarm: warmed || null
      });
      log(`done (${fields || '?'} fields, ${Math.round(durationMs / 1000)}s${warmed ? `, drafted ${warmed.apps} applicant(s)` : ''}): ${url}`);
    } else {
      await logEvent(null, `link_scan_${state === 'FAILED' ? 'failed' : 'retry'}`, 'scan-worker', {
        url, attempt: job.attempts, maxAttempts: job.max_attempts, error: String(errorText).slice(0, 300)
      });
      log(`${state.toLowerCase()} (attempt ${job.attempts}/${job.max_attempts}): ${url}`);
    }
    note('done', { url, ok, fields, state });
  } catch (err) {
    log('finish failed:', err.message);
  }
  kick();                                    // next row, if any is due
}

/* ------------------------- draft pre-warming ------------------------- */

// A fresh inventory is worthless to a CA until it is answered. Run the same
// draft pass the review pane would run, for every application still waiting on
// this link, so the pane opens showing filled answers + the real gaps only.
// Best-effort: an applicant whose pass fails is simply drafted on open instead.
async function prewarmDrafts(url) {
  if (!draftPrewarmEnabled()) return null;
  try {
    const link = await getJobLinkByUrl(url);
    if (!link) return { skipped: 'link_not_materialised' };
    const apps = await listApplicationsOnLink(link.id);
    if (!apps.length) return { apps: 0 };
    const { runDraftPass } = await import('../draft-service.js');
    // Sequential on purpose: the first applicant pays for the link's question
    // mapping, every applicant after them drafts with zero mapping calls.
    let deterministic = 0; let bound = 0; let genai = 0; let missing = 0; let mappingCalls = 0;
    const done = [];
    for (const app of apps) {
      try {
        const out = await runDraftPass(app.awl_id, link.id, { log: () => {} });
        deterministic += out.deterministic || 0;
        bound += out.bound || 0;
        genai += out.genai || 0;
        missing += out.missing || 0;
        mappingCalls += out.mappingCalls || 0;
        done.push({ app_id: app.id, awl_id: app.awl_id, total: out.total, bound: out.bound || 0, genai: out.genai || 0, missing: out.missing || 0 });
      } catch (err) {
        done.push({ app_id: app.id, awl_id: app.awl_id, error: String(err.message || err).slice(0, 160) });
      }
    }
    return { apps: done.filter((d) => !d.error).length, deterministic, bound, genai, missing, mappingCalls, detail: done.slice(0, 12) };
  } catch (err) {
    return { skipped: String(err.message || err).slice(0, 160) };
  }
}

/* ----------------------------- the scanner ---------------------------- */

// One child process per claim, delegating to scripts/scan-link.js so there is
// exactly ONE scan implementation (local cache -> shared Azure cache -> live
// SCAN_ONLY Chromium -> publish to both). Output is kept bounded: the tail is
// what a DEV reads when a link parks as FAILED.
function runScanner(url) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(process.execPath, [SCANNER, url], {
        cwd: DASHBOARD,
        // Scans are evidence-free structure capture: no form is filled and
        // nothing is submitted, so a hidden window is safe and keeps the
        // operator's screen free for the headed APPLY runs.
        env: { ...process.env, SCAN_ONLY: 'true', SCAN_HEADLESS: process.env.SCAN_HEADLESS ?? 'true' },
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (err) {
      resolve({ exitCode: -1, spawnError: String(err?.message || err), out: '', tail: '' });
      return;
    }
    const entry = inFlight.get(url);
    if (entry) entry.child = child;

    let buf = '';
    const keep = (chunk) => {
      buf += String(chunk);
      if (buf.length > 8000) buf = buf.slice(-6000);        // bounded log tail
    };
    child.stdout.on('data', keep);
    child.stderr.on('data', keep);

    const timer = setTimeout(() => {
      resolve({ exitCode: -1, timedOut: true, out: buf, tail: buf.slice(-1500) });
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }, TIMEOUT_MS);
    timer.unref?.();

    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ exitCode: -1, spawnError: String(err?.message || err), out: buf, tail: buf.slice(-1500) });
    });
    child.on('exit', (code) => {
      clearTimeout(timer);
      resolve({ exitCode: code ?? 1, out: buf, tail: buf.slice(-1500), durationMs: Date.now() - startedAt });
    });
  });
}

/* ----------------------------- reporting ----------------------------- */

/** Live view for the DEV pane: what is running, due, and recently finished. */
export async function scanQueueState({ limit = 15 } = {}) {
  const [counts, recent] = await Promise.all([scanJobCounts(), listScanJobs({ limit })]);
  return {
    enabled: autoScanEnabled(),
    prewarm: draftPrewarmEnabled(),
    headless: process.env.SCAN_HEADLESS !== 'false',
    claimer: CLAIMER,
    started,
    maxConcurrent: MAX_SCAN,
    pollMs: POLL_MS,
    timeoutMs: TIMEOUT_MS,
    counts,
    running: [...inFlight.entries()].map(([url, v]) => ({
      url, jobId: v.jobId, seconds: Math.round((Date.now() - v.startedAt) / 1000)
    })),
    recent: recent.map((r) => ({
      id: r.id, url: r.url, link_id: r.link_id, status: r.status, reason: r.reason,
      attempts: r.attempts, max_attempts: r.max_attempts, fields: r.fields,
      last_error: r.last_error, next_attempt_at: r.next_attempt_at,
      duration_ms: r.duration_ms, updated_at: r.updated_at
    }))
  };
}

/**
 * What a specific link's scan looks like right now — used by the CA review pane
 * so it can say "pre-scan in progress" instead of "not scanned".
 * Returns 'pre_scanning' | 'queued' | 'failed' | null (null = nothing in flight
 * and nothing pending; the caller decides between 'scanned' and 'unscanned').
 */
export async function scanStateForUrl(url) {
  const canon = canonicalJobUrl(String(url || '').trim());
  if (!canon) return null;
  try {
    const job = await getScanJobByUrl(canon);
    if (!job) return null;
    if (job.status === 'RUNNING') return 'pre_scanning';
    if (job.status === 'PENDING') return inFlight.has(canon) ? 'pre_scanning' : 'queued';
    if (job.status === 'FAILED') return 'failed';
    return null;
  } catch {
    return null;
  }
}

export function status() {
  return { started, inFlight: inFlight.size, maxConcurrent: MAX_SCAN, scanner: SCANNER };
}
