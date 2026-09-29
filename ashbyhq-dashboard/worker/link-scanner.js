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
import { browserState, checkBrowser } from '../core/browser-check.js';
import { browserCapacity } from '../core/host-capacity.js';
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
// A scan is only one page load, but it is still a Chromium, and the same host
// usually runs the apply worker too. The apply side owns real submissions, so it
// gets the host's measured browser capacity and the scanner takes at most half of
// it (never below 1, which is already its code default). A scan that has to wait
// costs a few minutes and is refunded/deferred gracefully; an apply killed by
// memory pressure costs an applicant, which is why the split leans this way.
const SCAN_BUDGET = browserCapacity();
const WANTED_SCAN = Math.max(1, Number(process.env.SCAN_CONCURRENCY || 1));
const MAX_SCAN = Math.min(WANTED_SCAN, Math.max(1, Math.floor(SCAN_BUDGET.capacity / 2)));
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
  log(`started (max ${MAX_SCAN} concurrent${WANTED_SCAN > MAX_SCAN ? ` of ${WANTED_SCAN} wanted, host fits ${SCAN_BUDGET.capacity}` : ''}, poll ${POLL_MS}ms, headless ${process.env.SCAN_HEADLESS === 'false' ? 'off' : 'on'}).`);
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
  // Unlike the apply worker, this one may still claim a row without a browser:
  // tiers 1 and 2 of scripts/scan-link.js answer a link from the local or shared
  // inventory and never open a window. What it must never do is spend attempts on
  // a link that needs a page it cannot load, so the capability is passed down and
  // that case is DEFERRED (row returned, attempt refunded) instead of FAILED.
  //
  // Mode 'scan', never the default: the engine scans HEADLESS and applies
  // HEADED, so a display-less container is a valid scanner and an invalid
  // applicator. Asking the apply question here would defer every scan on exactly
  // the host that can answer it.
  if (!browserState('scan').ok) checkBrowser({ mode: 'scan' }).catch(() => {});
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
  await logEvent(null, 'link_scan_start', 'scan-worker', { url: job.url, attempt: job.attempts, reason: job.reason, browser: browserState('scan').ok });
  run(job).catch((e) => log('run:', e.message));
}

async function run(job) {
  const url = job.url;
  const browserOk = browserState('scan').ok;
  const outcome = await runScanner(url, browserOk);
  const finishedAt = Date.now();
  const durationMs = finishedAt - (inFlight.get(url)?.startedAt || finishedAt);
  inFlight.delete(url);
  const out = String(outcome.out || '');

  // scan-link.js reports its tier in one of three phrasings; the field count is
  // what the DEV table shows, so grab it whichever way it was written.
  const fields = Number(out.match(/(?:Stored|Restored|Already scanned:)\D*(\d+)\s*field/)?.[1] || 0);
  // A CLOSED / REMOVED posting. scan-link.js already captured the proof, recorded
  // it on the link row and exited 0, so this is a resolved outcome, not a failure:
  // the row goes DONE (never retried) and the draft pre-warm is skipped because
  // there is no form to answer. The assigned CA reads the screenshot in the pane.
  const unavailable = /POSTING_UNAVAILABLE/.test(out);
  const unavailableReason = (out.match(/POSTING_UNAVAILABLE:\s*(.+)/) || [])[1]?.trim().slice(0, 300) || '';
  // Where the inventory came from. "✓ scanned in 8s" is a cache answer, not a
  // browser scan, and a DEV reading the table deserves to know which one happened.
  const via = unavailable ? 'posting-gone'
    : /Already scanned:/.test(out) ? 'local-cache'
      : /Restored \d+ field\(s\) from public\.ashby_joblink_questions/.test(out) ? 'shared-cache'
        : 'browser';
  // This host had no browser and the link needed one: not a failure, and above
  // all not an attempt. The row goes back untouched for a capable host.
  const needsBrowser = !browserOk && (/NEEDS_BROWSER/.test(out) || outcome.exitCode === 3);
  // A refused scan (listing page / "Page not found") is the LINK's fault, not the
  // host's: retries burn here are correct, and the row should park FAILED quickly
  // with the engine's own sentence as the reason a DEV can act on.
  const refused = /Scan refused/.test(out);
  const ok = !needsBrowser && outcome.exitCode === 0 && !outcome.timedOut && !outcome.spawnError;
  const errorText = needsBrowser
    ? `no headless browser on ${browserState('scan').host} - waiting for a host that has one`
    : outcome.timedOut ? `timed out after ${Math.round(TIMEOUT_MS / 60000)}m`
      : outcome.spawnError || describeFailure(out, outcome) || `exit ${outcome.exitCode}`;

  try {
    const state = await finishScanJob(job.id, {
      ok, defer: needsBrowser, fields, via,
      // A refused link has nothing to retry with the same URL, so do not spend
      // the remaining attempts grinding the same page: park it now.
      attempts: refused ? job.max_attempts : job.attempts,
      error: ok ? null : errorText, maxAttempts: job.max_attempts
    });
    if (!needsBrowser) await markScanJobDuration(job.id, durationMs);

    if (ok) {
      const warmed = unavailable ? null : await prewarmDrafts(url);
      if (unavailable) {
        await logEvent(null, 'link_posting_unavailable', 'scan-worker', {
          url, reason: unavailableReason, host: browserState('scan').host, attempt: job.attempts
        });
        log(`posting unavailable (closed/removed) - proof recorded for the assigned CA(s): ${url}`);
      } else {
        await logEvent(null, 'link_scan_done', 'scan-worker', {
          url, fields, via, seconds: Math.round(durationMs / 1000), attempt: job.attempts, prewarm: warmed || null
        });
        log(`done (${fields || '?'} fields via ${via}, ${Math.round(durationMs / 1000)}s${warmed ? `, drafted ${warmed.apps} applicant(s)` : ''}): ${url}`);
      }
    } else if (needsBrowser) {
      await logEvent(null, 'link_scan_deferred', 'scan-worker', { url, error: errorText, host: browserState('scan').host });
      log(`deferred (no browser here): ${url}`);
    } else {
      await logEvent(null, `link_scan_${state === 'FAILED' ? 'failed' : 'retry'}`, 'scan-worker', {
        url, attempt: job.attempts, maxAttempts: job.max_attempts, via, error: String(errorText).slice(0, 300)
      });
      log(`${state.toLowerCase()} (attempt ${job.attempts}/${job.max_attempts}): ${url} — ${String(errorText).slice(0, 180)}`);
    }
    note('done', { url, ok, fields, via, state });
  } catch (err) {
    log('finish failed:', err.message);
  }
  kick();                                    // next row, if any is due
}

/* The last line of a failed child is usually the WRAPPER's summary ("No scan
   output produced"), which describes nothing. The engine's own message is one
   line earlier and is the whole reason - losing it is why the Railway browser
   outage read as an unsolvable mystery for five links and two apply runs. */
const FAILURE_SIG = /Fatal error|Scan failed|Scan refused|Error:|error while loading|Executable doesn't exist|browserType|Cannot find module|ENOENT|EACCES|timed out|Timeout\d+ms|out of memory|heap$/i;
function describeFailure(out, outcome) {
  const lines = String(out || '').split('\n').map((l) => l.trim()).filter(Boolean);
  if (!lines.length) return 'the scan produced no output at all (the engine never reported anything)';
  const meaningful = lines.filter((l) => FAILURE_SIG.test(l) && !/^No scan output produced/.test(l));
  const picked = (meaningful.length ? meaningful.slice(-2) : lines.filter((l) => !/^No scan output produced/.test(l)).slice(-1));
  const summary = picked.join(' | ');
  if (summary) return summary.slice(0, 300);
  return (outcome.tail || '').slice(-200).trim() || `exit ${outcome.exitCode}`;
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
// `allowBrowser=false` puts the child in cache-only mode: it may still answer the
// link from an inventory, but it will never try to open a window it cannot open.
function runScanner(url, allowBrowser = true) {
  return new Promise((resolve) => {
    const startedAt = Date.now();
    let child;
    try {
      child = spawn(process.execPath, [SCANNER, url], {
        cwd: DASHBOARD,
        // Scans are evidence-free structure capture: no form is filled and
        // nothing is submitted, so a hidden window is safe and keeps the
        // operator's screen free for the headed APPLY runs.
        env: { ...process.env, SCAN_ONLY: 'true', SCAN_HEADLESS: process.env.SCAN_HEADLESS ?? 'true', SCAN_NO_BROWSER: allowBrowser ? 'false' : 'true' },
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
  const browser = browserState('scan');
  return {
    enabled: autoScanEnabled(),
    prewarm: draftPrewarmEnabled(),
    headless: process.env.SCAN_HEADLESS !== 'false',
    claimer: CLAIMER,
    started,
    maxConcurrent: MAX_SCAN,
    // Visible so "the scanner is slower than I configured" is explainable: it is
    // this host's memory saying so, not a setting being ignored.
    wantedConcurrent: WANTED_SCAN,
    hostCapacity: SCAN_BUDGET.reason,
    pollMs: POLL_MS,
    timeoutMs: TIMEOUT_MS,
    // This host's own answer to "can you open a window". A browserless container
    // still drains the cache tiers, so the DEV pane has to say which of the two
    // it is looking at - otherwise "0 pending, nothing running" reads as healthy.
    browser: { ok: browser.ok, host: browser.host, note: browser.note, checked: browser.checked },
    counts,
    running: [...inFlight.entries()].map(([url, v]) => ({
      url, jobId: v.jobId, seconds: Math.round((Date.now() - v.startedAt) / 1000)
    })),
    recent: recent.map((r) => ({
      id: r.id, url: r.url, link_id: r.link_id, status: r.status, reason: r.reason,
      attempts: r.attempts, max_attempts: r.max_attempts, fields: r.fields,
      scan_via: r.scan_via, last_error: r.last_error, next_attempt_at: r.next_attempt_at,
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
