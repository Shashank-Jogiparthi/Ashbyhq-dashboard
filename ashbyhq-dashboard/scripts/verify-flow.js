#!/usr/bin/env node
/* =====================================================================
   END-TO-END FLOW VERIFIER — no browser, no apply run.

     node scripts/verify-flow.js [--crm]

   Proves the contract the platform is built on, against the REAL database
   the dashboard is configured for (hosted Supabase or local SQLite):

     1. the durable pre-scan queue (link_scan_jobs) behaves like a worker
        queue: enqueue -> dedupe -> single-winner claim -> backoff ->
        FAILED -> retry -> DONE, and the CA pane can read its state;
     1b. the browser CAPABILITY gate: a host that cannot prove it can launch a
        browser never claims work it would destroy, a link needing a page load
        is DEFERRED (attempt refunded) instead of failed, a non-form scan is
        refused before it can poison the shared cache, and a machine fault
        hands an application back to the queue rather than filing FAILED -
        parked with a retry time so the same dead host cannot loop on it. The
        gate answers SEPARATELY for apply and scan, because those are different
        machines in practice, and how an APPLY launches is decided once for the
        whole platform by core/apply-mode.js.
     1c. the host's BUDGET and the fault split: browsers at once are counted
        against the memory actually available (core/host-capacity.js), and a run
        that was killed or said nothing without ever writing a result is a HOST
        fault handed back to the queue, not an applicant's FAILED record
        (core/host-fault.js).
     2. an applicant is addressable by AWL-ID alone (profile present /
        needs a fetch);
     3. the post-SUCCESS privacy erase removes the form data and keeps
        exactly status + reason + the two screenshot URLs, and only clears
        the shared profile when nothing else is open for that AWL-ID;
     4. every stage of the pipeline is visible to the DEV through the
        activity feed, including the ?type=<prefix> filter.

   Everything it creates is synthetic (AWL-VERIFY-1) and deleted again in
   the `finally` block, so running it against the live cache is safe.
   --crm additionally calls the real connector for that fake AWL-ID and
   expects "seen 0" (proves the fetch path works without a browser).
   ===================================================================== */
import { migrate, db, nowIso, BACKEND } from '../db/index.js';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  enqueueScanJobs, claimNextScanJob, finishScanJob, markScanJobDuration,
  requeueFailedScanJobs, scanJobCounts, getScanJobByUrl, listEvents,
  purgeApplicantFormData, applicantNeedsProfile, logEvent, upsertFieldAnswer,
  listFieldAnswers, hasBlockingMissingFacts, saveJobLinkFields, applyCaEdits,
  handBackToQueue, listQueuedForWorker, claimForRun
} from '../db/store.js';
import { scanStateForUrl } from '../worker/link-scanner.js';
import { browserState, canDriveBrowsers } from '../core/browser-check.js';
import { applyLaunchMode } from '../core/apply-mode.js';
import { hostMemory, browserCapacity, effectiveLimit } from '../core/host-capacity.js';
import { classifyRunFault } from '../core/host-fault.js';
import { judgeScan, inventoryIsResidue } from '../core/scan-verdict.js';
import { buildReviewQuestions, questionIsOptional } from '../draft-service.js';
import { fieldKeyOf } from '../../field-applier.js';
import { __internals } from '../../genai-resume-filler.js';

const AWL = 'AWL-VERIFY-1';
const URL_A = 'https://jobs.ashbyhq.com/verify/11111111-1111-4111-8111-111111111111';
const URL_B = 'https://jobs.ashbyhq.com/verify/22222222-2222-4222-8222-222222222222';
const URL_C = 'https://jobs.ashbyhq.com/verify/33333333-3333-4333-8333-333333333333';

let passed = 0;
let failed = 0;
const SCAN_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'scan-link.js');
const PROBE_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'core', 'browser-probe.js');
const RUNNER_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'worker', 'runner.js');
function runScanScript(url, env) {
  return runChild(SCAN_SCRIPT, [url], env);
}
function runChild(script, args, env) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [script, ...args], {
      cwd: path.resolve(path.dirname(script), '..'),
      env: { ...process.env, ...env, AUTO_SCAN_ON_LINK: 'false' },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });
    child.on('error', (err) => resolve({ code: -1, out: `${out}${err?.message || err}` }));
    child.on('exit', (code) => resolve({ code: code ?? 1, out }));
  });
}
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? `  (${detail})` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
  return ok;
}
const step = (t) => console.log(`\n${t}`);

/* ------------------------------ fixture ----------------------------- */

async function makeLink(url) {
  const slug = url.split('/').pop();
  // Param order must follow the column list: url, then url_hash.
  await db.prepare(`INSERT INTO job_links (company, title, url, url_hash, link_status, seeded_at)
    VALUES ('Verify Co', 'Role', ?, ?, 'valid', ?) ON CONFLICT (url) DO NOTHING`).run(url, `verify-${slug}`, nowIso());
  const found = await db.prepare('SELECT id FROM job_links WHERE url = ?').get(url);
  if (!found?.id) throw new Error(`job_links row for ${url} did not materialise`);
  return Number(found.id);
}

async function makeApplicant(profileJson) {
  await db.prepare(`INSERT INTO applicants (awl_id, full_name, email, profile_json)
    VALUES (?, 'Verify Synthetic', 'verify@invalid.local', ?)
    ON CONFLICT (awl_id) DO UPDATE SET profile_json = EXCLUDED.profile_json`).run(AWL, profileJson);
}

async function makeApplication(linkId, status = 'ASSIGNED') {
  await db.prepare(`INSERT INTO applications (awl_id, link_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT (awl_id, link_id) DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`)
    .run(AWL, linkId, status, nowIso(), nowIso());
  const found = await db.prepare('SELECT id FROM applications WHERE awl_id = ? AND link_id = ?').get(AWL, linkId);
  if (!found?.id) throw new Error(`applications row for link ${linkId} did not materialise`);
  return Number(found.id);
}

// The queue lives in the SHARED database, so a generic "next due row" claim can
// hand this verifier somebody else's real link — and a row it hands back is still
// a row it touched. Claiming BY URL keeps every assertion about the atomic CAS
// (single winner, RUNNING stamp, due-time gate) exactly as strong, and leaves
// every foreign row alone. `url` is required: a typo must fail loudly, not fall
// back to grabbing a real applicant's link.
async function claimMine(claimer, url) {
  if (!url) throw new Error('claimMine needs the fixture URL');
  return claimNextScanJob({ claimer, url });
}

async function cleanup() {
  // applications / answers / job_link_fields cascade off applicants + job_links.
  await db.prepare('DELETE FROM application_events WHERE application_id IN (SELECT id FROM applications WHERE awl_id = ?)').run(AWL);
  await db.prepare('DELETE FROM applications WHERE awl_id = ?').run(AWL);
  await db.prepare('DELETE FROM applicant_field_answers WHERE awl_id = ?').run(AWL);
  await db.prepare('DELETE FROM applicants WHERE awl_id = ?').run(AWL);
  await db.prepare('DELETE FROM job_links WHERE url IN (?, ?)').run(URL_A, URL_B);
  await db.prepare('DELETE FROM job_links WHERE url_hash IN (?, ?)').run(URL_A, URL_B);
  await db.prepare('DELETE FROM link_scan_jobs WHERE url IN (?, ?)').run(URL_A, URL_B);
  await db.prepare('DELETE FROM job_links WHERE url = ?').run(URL_C);
  await db.prepare('DELETE FROM job_links WHERE url_hash = ?').run(URL_C);
  await db.prepare('DELETE FROM link_scan_jobs WHERE url = ?').run(URL_C);
}

/* ------------------------------ checks ------------------------------ */

async function verifySchema() {
  step('1. schema (migrate created the new structures)');
  try {
    await db.prepare('SELECT id, status, attempts, next_attempt_at FROM link_scan_jobs LIMIT 0').all();
    check('link_scan_jobs exists', true);
  } catch (err) { check('link_scan_jobs exists', false, err.message); }
  try {
    await db.prepare('SELECT purged_at FROM applications LIMIT 0').all();
    check('applications.purged_at exists', true);
  } catch (err) { check('applications.purged_at exists', false, err.message); }
  try {
    await db.prepare('SELECT scan_via FROM link_scan_jobs LIMIT 0').all();
    check('link_scan_jobs.scan_via exists (a cache answer must not look like a scan)', true);
  } catch (err) { check('link_scan_jobs.scan_via exists', false, err.message); }
  try {
    // The hand-back brake: without this column a QUEUED row a host cannot launch
    // is re-claimed on every poll tick.
    await db.prepare('SELECT next_attempt_at FROM applications LIMIT 0').all();
    check('applications.next_attempt_at exists (hand-backs get a pause, not a loop)', true);
  } catch (err) { check('applications.next_attempt_at exists', false, err.message); }
  try {
    await db.prepare('SELECT screenshots_json, fail_reason, screenshot_path FROM applications LIMIT 0').all();
    check('status + reason + screenshot columns exist', true);
  } catch (err) { check('status + reason + screenshot columns exist', false, err.message); }
}

async function verifyScanQueue() {
  step('2. pre-scan worker queue (durable, claim-based, retrying)');
  const q1 = await enqueueScanJobs([URL_A], { reason: 'verify' });
  check('intent is queued as a row', q1.queued.length === 1, JSON.stringify(q1));
  const q2 = await enqueueScanJobs([URL_A], { reason: 'verify' });
  check('a second intent for the same link dedupes', q2.queued.length === 0 && q2.skipped[0]?.why === 'already_queued', JSON.stringify(q2.skipped));

  const job = await claimMine('verify-process', URL_A);
  check('a claim wins the row and stamps RUNNING', job?.url === URL_A && job.status === 'RUNNING' && job.attempts === 1, `attempt ${job?.attempts}`);
  check('no second worker can take a claimed row', !(await claimMine('verify-other', URL_A)));
  check('CA pane reports the live scan', (await scanStateForUrl(URL_A)) === 'pre_scanning');

  const retry = await finishScanJob(job.id, { ok: false, error: 'verify: simulated failure', maxAttempts: 3, attempts: 1 });
  const row1 = await getScanJobByUrl(URL_A);
  check('a failure backs off instead of giving up', retry === 'RETRY' && row1.status === 'PENDING' && Date.parse(row1.next_attempt_at) > Date.now(),
    `next attempt at ${String(row1.next_attempt_at).slice(11, 19)}`);
  check('the reason is kept for the DEV', /simulated failure/.test(row1.last_error || ''), row1.last_error);
  check('CA pane says "queued" while it waits', (await scanStateForUrl(URL_A)) === 'queued');
  check('a due-time row is not claimable yet', !(await claimMine('verify-early', URL_A)));

  await db.prepare('UPDATE link_scan_jobs SET next_attempt_at = NULL, status = ? WHERE url = ?').run('PENDING', URL_A);
  await claimMine('verify-process', URL_A);                                     // attempt 2
  await finishScanJob(row1.id, { ok: false, error: 'verify: again', maxAttempts: 3, attempts: 2 });
  await db.prepare('UPDATE link_scan_jobs SET next_attempt_at = NULL WHERE url = ?').run(URL_A);
  await claimMine('verify-process', URL_A);                                     // attempt 3
  const parked = await finishScanJob(row1.id, { ok: false, error: 'verify: exhausted', maxAttempts: 3, attempts: 3 });
  check('after max_attempts the link parks as FAILED', parked === 'FAILED' && (await getScanJobByUrl(URL_A)).status === 'FAILED', `attempts ${(await getScanJobByUrl(URL_A)).attempts}`);
  check('CA pane says the scan failed', (await scanStateForUrl(URL_A)) === 'failed');

  // The DEV retry button is deliberately global ("retry everything that gave
  // up"), so on a shared DB it would re-arm real links too: snapshot them and put
  // them back exactly as found, so the assertion proves the button works without
  // this verifier touching anybody else's queue.
  const foreign = await db.prepare(`SELECT id, status, attempts, last_error, next_attempt_at FROM link_scan_jobs
    WHERE status = 'FAILED' AND url <> ?`).all(URL_A);
  const requeued = await requeueFailedScanJobs();
  check('the DEV retry button re-arms failed links', requeued >= 1 && (await getScanJobByUrl(URL_A)).status === 'PENDING',
    `requeued ${requeued}${foreign.length ? ` (${foreign.length} foreign row(s) restored below)` : ''}`);
  for (const f of foreign) {
    await db.prepare(`UPDATE link_scan_jobs SET status = 'FAILED', attempts = ?, last_error = ?,
      next_attempt_at = ?, claimed_by = NULL, updated_at = ? WHERE id = ?`)
      .run(f.attempts, f.last_error, f.next_attempt_at, nowIso(), f.id);
  }
  if (foreign.length) console.log(`  (left ${foreign.length} unrelated FAILED row(s) exactly as found)`);

  await db.prepare('UPDATE link_scan_jobs SET next_attempt_at = NULL WHERE url = ?').run(URL_A);
  const last = await claimMine('verify-process', URL_A);
  await finishScanJob(last.id, { ok: true, fields: 9, maxAttempts: 3, attempts: last.attempts });
  await markScanJobDuration(last.id, 4321);
  const done = await getScanJobByUrl(URL_A);
  const counts = await scanJobCounts();
  check('a successful scan lands as DONE with its field count', done.status === 'DONE' && done.fields === 9 && done.duration_ms === 4321,
    `counts ${JSON.stringify(counts)}`);
  check('a DONE link is not re-scanned by default', (await enqueueScanJobs([URL_A])).skipped[0]?.why === 'already_scanned');
  check('...unless an explicit re-scan is asked for', (await enqueueScanJobs([URL_A], { force: true })).queued.length === 1);
  check('an unknown link has no scan state at all', (await scanStateForUrl(URL_B)) === null);
  await db.prepare('DELETE FROM link_scan_jobs WHERE url = ?').run(URL_A);
}

/* ------------- 2b. browser capability gate + scan-verdict rules ----------
   These checks exist because of one incident class: a host that cannot open a
   browser claimed shared-queue work anyway, and filed its own missing binary as
   the LINK's failure (five links, "No scan output produced") and later as the
   APPLICANT's failure (two real apply runs). A browserless host must be unable to
   cause either again, on any machine, so the contract is asserted here rather
   than trusted. Nothing in this section launches a browser. */
const formFields = (n) => Array.from({ length: n }, (_, i) => ({ question: `Q${i + 1}`, kind: 'text' }));

async function verifyCapabilityGate() {
  step('2b. browser capability gate + scan verdict rules');

  check('a host is treated as incapable until a probe proves otherwise',
    !canDriveBrowsers() && browserState().checked === false,
    `state ${JSON.stringify({ ok: browserState().ok, checked: browserState().checked, host: browserState().host })}`);

  // TWO VERDICTS, because the two workers do not need the same machine. The engine
  // applies HEADED (a real window is the signal Ashby's anti-spam filter reads) and
  // scans HEADLESS, so a display-less container is a valid scanner and an invalid
  // applicator. One headless-only answer is exactly what let Railway report itself
  // "ready" and then destroy two real CA applications at `browserType.launch:
  // Target page, context or browser has been closed`, on a loop.
  const applyVerdict = browserState('apply');
  const scanVerdict = browserState('scan');
  check('apply and scan keep SEPARATE verdicts, each starting unchecked',
    applyVerdict.mode === 'apply' && scanVerdict.mode === 'scan'
      && applyVerdict.checked === false && scanVerdict.checked === false,
    JSON.stringify({ apply: applyVerdict.checked, scan: scanVerdict.checked }));
  check('both modes fail closed before any probe has run',
    canDriveBrowsers('apply') === false && canDriveBrowsers('scan') === false);

  // The mode has to reach the probe, not just the cache. Point it at a browser
  // that does not exist and both modes must say MISSING — proof argv[2] is wired
  // and that neither mode can report a false READY from a missing binary.
  const bogus = { CHROME_PATH: 'Z:\\no-such-browser-dir\\chrome.exe' };
  const probeApply = await runChild(PROBE_SCRIPT, ['apply'], bogus);
  const probeScan = await runChild(PROBE_SCRIPT, ['scan'], bogus);
  const markerLine = (o) => o.trim().split('\n').find((l) => l.startsWith('BROWSER_PROBE')) || '(no marker line)';
  check('the probe takes its mode from argv and answers MISSING, never OK',
    /^BROWSER_PROBE\tMISSING/m.test(probeApply.out) && /^BROWSER_PROBE\tMISSING/m.test(probeScan.out),
    `apply: ${markerLine(probeApply.out)} | scan: ${markerLine(probeScan.out)}`);

  // ONE RULE FOR HOW AN APPLY LAUNCHES. Three places used to decide "headed or
  // headless" by hand and disagreed, which is how a display-less container called
  // itself READY: the engine died mid-submission while the probe, launching
  // headless, saw no problem. So the rule is asserted as a table, and the
  // hand-rolled copies are asserted to be gone. A container that applies headed
  // cannot apply at all; a laptop forced headless throws away the one signal
  // Ashby's anti-spam filter reads, so both directions of the table matter.
  check('APPLY_HEADLESS=true forces headless, even on a desktop',
    applyLaunchMode({ APPLY_HEADLESS: 'true' }, 'win32').headless === true);
  check('APPLY_HEADLESS=false forces a real window, even on a host with no display',
    applyLaunchMode({ APPLY_HEADLESS: 'false' }, 'linux').headless === false,
    applyLaunchMode({ APPLY_HEADLESS: 'false' }, 'linux').reason);
  check("the engine's HEADLESS alias is honoured too",
    applyLaunchMode({ HEADLESS: 'true' }, 'win32').headless === true);
  check('a linux container with no display applies HEADLESS (the Railway case)',
    applyLaunchMode({}, 'linux').headless === true && applyLaunchMode({ DISPLAY: '  ' }, 'linux').headless === true);
  check('...and stops guessing the moment a display exists',
    applyLaunchMode({ DISPLAY: ':0' }, 'linux').headless === false
      && applyLaunchMode({ WAYLAND_DISPLAY: 'wayland-0' }, 'linux').headless === false,
    'a Wayland-only desktop has no DISPLAY and must not be forced hidden');
  check('a desktop OS keeps the visible window it can actually show',
    applyLaunchMode({}, 'win32').headless === false && applyLaunchMode({}, 'darwin').headless === false);
  check('an automatic decision says why, a configured one says so',
    /display/.test(applyLaunchMode({}, 'linux').reason)
      && applyLaunchMode({}, 'linux').explicit === false
      && applyLaunchMode({ APPLY_HEADLESS: 'true' }, 'win32').explicit === true);

  const probeSrc = fs.readFileSync(PROBE_SCRIPT, 'utf8');
  const runnerSrc = fs.readFileSync(RUNNER_SCRIPT, 'utf8');
  check('the probe and the worker both ask apply-mode.js instead of re-deriving it',
    /apply-mode\.js/.test(probeSrc) && /apply-mode\.js/.test(runnerSrc)
      && !/APPLY_HEADLESS[^\n]*===\s*'true'/.test(probeSrc)
      && !/APPLY_HEADLESS[^\n]*===\s*'true'/.test(runnerSrc));
  check('the worker hands the resolved mode to the engine it spawns (the engine itself is never edited)',
    /APPLY_HEADLESS:\s*String\(HEADLESS_APPLY\)/.test(runnerSrc));

  // ---- 1c. how many browsers a host may hold, and whose fault a death is ----
  // Three applications were claimed by ONE poll tick on the Railway container and
  // launched together; the Drata run died six seconds in - no result file, no
  // screenshot - while its two siblings submitted normally. The kernel chose the
  // victim and the applicant got the record: FAILED, "Engine process exited
  // without a result". Two rules close that: count browsers against the memory
  // that is really available, and never file a failure the form itself never
  // produced.
  const MB = 1024 * 1024;
  const cap = (mb, env = {}) => browserCapacity({ env, memory: { bytes: mb * MB, source: 'test' } });
  check('a 512MB container is allowed ONE browser, not four',
    cap(512).capacity === 1, cap(512).reason);
  check('a 2GB container fits four', cap(2048).capacity === 4);
  check('a host smaller than one browser still gets one (never zero - that would freeze the queue)',
    cap(200).capacity === 1 && cap(0).capacity === 1);
  check('APPLY_BROWSER_MB re-prices a browser on a host that needs it',
    cap(1024, { APPLY_BROWSER_MB: '1024' }).capacity === 1);
  check('MAX_BROWSERS overrides the measurement in both directions',
    cap(8192, { MAX_BROWSERS: '2' }).capacity === 2 && cap(512, { MAX_BROWSERS: '8' }).capacity === 8);
  check('the measurement reads a cgroup limit before os.totalmem, which reports the HOST node',
    /HOST_MEM_MB/.test(hostMemory({ HOST_MEM_MB: '600' }).source) && hostMemory({ HOST_MEM_MB: '600' }).bytes === 600 * MB
      && /cgroup|totalmem/.test(hostMemory({}).source));
  check('an explicit cap is honoured but never above what the host holds',
    effectiveLimit(4, cap(512)).limit === 1 && effectiveLimit(4, cap(512)).capped === true);
  check('"unlimited" means as many as fit, not as many as exist',
    effectiveLimit(Infinity, cap(1024)).limit === 2);
  check('a laptop with room to spare is not slowed down by a container rule',
    effectiveLimit(4, cap(16384)).limit === 4 && effectiveLimit(4, cap(16384)).capped === false);
  check('the real host reports a capacity of at least one browser',
    browserCapacity().capacity >= 1, browserCapacity().reason);

  const killed = { hasResult: false, exitSignal: 'SIGKILL', exitCode: null, output: '' };
  check('a run KILLED with no result is the machine\'s fault, not the applicant\'s',
    classifyRunFault(killed).hostFault === true
      && /SIGKILL/.test(classifyRunFault(killed).reason) && /memory/i.test(classifyRunFault(killed).reason),
    classifyRunFault(killed).reason);
  check('exit 137 (the OOM kill through a shell) reads the same way',
    classifyRunFault({ hasResult: false, exitCode: 137, output: 'half a line' }).hostFault === true);
  check('a process that vanished without a word decided nothing either',
    classifyRunFault({ hasResult: false, exitCode: 0, output: '   ' }).hostFault === true);
  check('a missing browser is still a host fault (the original bug class)',
    classifyRunFault({ hasResult: false, exitCode: 1, output: "Fatal error: browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium-1243/chrome" }).hostFault === true);
  check('...even when the engine also wrote a result, but never after a SUCCESS',
    classifyRunFault({ hasResult: true, outcome: 'failed', exitCode: 1, output: 'browserType.launch: Failed to launch' }).hostFault === true
      && classifyRunFault({ hasResult: true, outcome: 'success', exitCode: 1, output: 'browserType.launch: x' }).hostFault === false);
  check('a real run that printed its own fatal error stays the applicant\'s FAILED - with the ERROR, not the placeholder',
    classifyRunFault({ hasResult: false, outcome: 'failed', exitCode: 1, output: 'line one\nFatal error: page.goto: net::ERR_NAME_NOT_RESOLVED' }).hostFault === false
      && /ERR_NAME_NOT_RESOLVED/.test(classifyRunFault({ hasResult: false, outcome: 'failed', exitCode: 1, output: 'Fatal error: page.goto: net::ERR_NAME_NOT_RESOLVED' }).reason));
  check('a judged form keeps its banner as the reason',
    classifyRunFault({ hasResult: true, outcome: 'failed', exitCode: 0, output: 'Validation error found' }).reason === '');
  check('the worker uses that classifier and keeps the exit code as evidence',
    /classifyRunFault\(/.test(runnerSrc) && /child\.on\('close', \(code, signal\)/.test(runnerSrc)
      && !/const NO_BROWSER_SIG/.test(runnerSrc),
    'the signature lives in core/host-fault.js');

  // The verdict rules (pure): the shapes that used to be cached and published.
  const goodPosting = { h1: 'Staff Data Engineer', docTitle: 'Staff Data Engineer - Acme', jobTitle: '', headingAttr: '' };
  check('a real form is accepted', judgeScan({ posting: goodPosting, fields: formFields(12) }, URL_A).ok === true);
  check('a scan that found nothing at all is refused', judgeScan({ posting: goodPosting, fields: [] }, URL_A).ok === false);
  const listing = judgeScan(
    { posting: { h1: 'Open roles', docTitle: 'Open roles - Acme', jobTitle: '', headingAttr: '' }, fields: formFields(1) },
    'https://www.acme.com/careers/roles?ashby_jid=11111111-1111-4111-8111-111111111111');
  check('a job LISTING is refused before anything is written',
    !listing.ok && /not an application form|listing/i.test(listing.why || ''), listing.why);
  const notFound = judgeScan({ posting: { h1: 'Page not found', docTitle: 'Page not found' }, fields: formFields(3) }, URL_A);
  check('an Ashby "Page not found" is refused', !notFound.ok, notFound.why);
  check('one field on a non-form URL is residue, one field on an /application form is not',
    inventoryIsResidue(formFields(1), URL_A) && !inventoryIsResidue(formFields(1), `${URL_A}/application`));
  check('every refusal carries a sentence a DEV can act on',
    [listing, notFound].every((v) => typeof v.why === 'string' && v.why.length > 15));

  // Cache-only mode: the real script, driven as a browserless host drives it.
  const cacheOnly = await runScanScript(URL_C, { SCAN_NO_BROWSER: 'true' });
  check('a browserless host stops before launching anything (NEEDS_BROWSER + exit 3)',
    cacheOnly.code === 3 && /NEEDS_BROWSER/.test(cacheOnly.out), `exit ${cacheOnly.code}`);
  check('...and never reaches the browser-launch branch', !/Launching engine in SCAN_ONLY mode/.test(cacheOnly.out));

  // Defer, not fail: the row survives with its attempts intact.
  await enqueueScanJobs([URL_C], { reason: 'verify' });
  const jobC = await claimMine('verify-capability', URL_C);
  check('the capability-gated link is claimable at all', jobC?.url === URL_C, `attempt ${jobC?.attempts}`);
  const deferred = await finishScanJob(jobC.id, {
    ok: false, defer: true, error: 'verify: host has no browser', attempts: jobC.attempts, maxAttempts: 3
  });
  const rowC = await getScanJobByUrl(URL_C);
  check('a link needing a page load is DEFERRED on a browserless host', deferred === 'DEFERRED' && rowC.status === 'PENDING', deferred);
  check('the attempt it spent is refunded', rowC.attempts === jobC.attempts - 1, `attempts ${rowC.attempts}`);
  check('it waits for a capable host instead of hot-looping', Date.parse(rowC.next_attempt_at) > Date.now(),
    `next ${String(rowC.next_attempt_at).slice(11, 19)}`);

  await db.prepare('UPDATE link_scan_jobs SET next_attempt_at = NULL WHERE url = ?').run(URL_C);
  const again = await claimMine('verify-capability', URL_C);
  const doneState = await finishScanJob(again.id, { ok: true, fields: 12, via: 'shared-cache', attempts: again.attempts });
  const doneRow = await getScanJobByUrl(URL_C);
  check('a cache answer is recorded AS a cache answer', doneState === 'DONE' && doneRow.scan_via === 'shared-cache' && doneRow.fields === 12,
    `via ${doneRow.scan_via}`);
  await db.prepare("UPDATE link_scan_jobs SET status = 'RUNNING' WHERE url = ?").run(URL_C);
  await finishScanJob(doneRow.id, { ok: false, error: 'verify: refused', attempts: 1, maxAttempts: 3 });
  check('a failure clears the stale provenance instead of inheriting it', (await getScanJobByUrl(URL_C)).scan_via == null);
}

/* -------- 3c. a machine fault must never become an applicant's failure ------ */
async function verifyHandBack(appId) {
  step('3c. hand-back: no browser on a host is not a FAILED application');
  await db.prepare("UPDATE applications SET status = 'APPLYING', fail_reason = NULL WHERE id = ?").run(appId);
  const out = await handBackToQueue(appId, "verify: browserType.launch: Executable doesn't exist");
  const row = await db.prepare('SELECT status, fail_reason, queued_at FROM applications WHERE id = ?').get(appId);
  check('an APPLYING run on a browserless host returns to QUEUED', out?.status === 'QUEUED' && row.status === 'QUEUED', row.status);
  check('the machine\'s error is not filed as the applicant\'s failure', row.fail_reason == null, String(row.fail_reason));
  const events = await listEvents({ limit: 20, type: 'application.handback' });
  check('the hand-back is visible in the activity feed', events.some((e) => Number(e.application_id) === Number(appId)));

  // The brake. Without a parked retry time the next poll tick re-claims the same
  // row on the same dead host, and a machine fault becomes a claim/launch/fail
  // loop: Railway ran the same two applications dozens of times in four minutes.
  const parked = await db.prepare('SELECT next_attempt_at FROM applications WHERE id = ?').get(appId);
  check('a handed-back application is PARKED until a retry, not instantly due',
    Date.parse(parked.next_attempt_at) > Date.now(), `retry at ${String(parked.next_attempt_at).slice(11, 19)}`);
  check('the queue will not offer it to a host while it is parked',
    !(await listQueuedForWorker()).some((r) => Number(r.id) === Number(appId)));
  check('and the atomic claim refuses it too, whatever the poll loop read',
    (await claimForRun(appId, 'verify-while-parked')) === null,
    'claim returns null while next_attempt_at is in the future');

  // The pause is a brake on a machine fault, never on a human: as soon as it is
  // cleared (which is what APPLY and DEV Retry do) the same row is due again.
  await db.prepare("UPDATE applications SET next_attempt_at = NULL WHERE id = ?").run(appId);
  check('clearing the pause makes the row due again immediately',
    (await listQueuedForWorker()).some((r) => Number(r.id) === Number(appId)),
    'next_attempt_at = NULL means due now');

  await db.prepare("UPDATE applications SET status = 'SUCCESS', next_attempt_at = NULL WHERE id = ?").run(appId);
  const nope = await handBackToQueue(appId, 'verify: a late straggler must not re-open a submission');
  check('a finished submission is never re-opened by a hand-back',
    nope === null && (await db.prepare('SELECT status FROM applications WHERE id = ?').get(appId)).status === 'SUCCESS');
}

async function verifyApplicantAndPurge() {
  step('3. AWL-ID -> profile, and the post-success erase');
  await makeApplicant('{}');
  check('an empty snapshot is flagged as needing a CRM fetch', await applicantNeedsProfile(AWL));
  await makeApplicant(JSON.stringify({ personal: { name: 'Verify Synthetic' }, raw: { client: { applywizz_id: AWL } } }));
  check('a stored snapshot means no fetch is needed', !(await applicantNeedsProfile(AWL)));

  const linkA = await makeLink(URL_A);
  const linkB = await makeLink(URL_B);
  const appA = await makeApplication(linkA);
  const appB = await makeApplication(linkB);

  // The FORM inventory (what a scan writes) is what the review pane and the
  // APPLY gate read, so the fixture has to carry one: a required text box, a
  // radio whose options the CA must be able to pick from, and a question the
  // draft never answered at all (the disappearing-question regression).
  const qName = 'Full Name';
  const qGender = 'Gender';
  const qLinkedin = '[Optional] LinkedIn profile URL';
  await saveJobLinkFields(linkA, [
    { question: qName, kind: 'text', required: true },
    { question: qGender, kind: 'radio', options: ['Female', 'Male', 'Prefer not to say'], required: true },
    { question: qLinkedin, kind: 'text', required: null }
  ]);
  await upsertFieldAnswer({ awlId: AWL, linkId: linkA, fieldKey: fieldKeyOf(qName), questionText: qName, fieldType: 'text', value: 'Verify Synthetic', source: 'deterministic', sortOrder: 0 });
  await upsertFieldAnswer({ awlId: AWL, linkId: linkA, fieldKey: fieldKeyOf(qLinkedin), questionText: qLinkedin, fieldType: 'text', value: null, source: 'missing_fact', optional: 1, sortOrder: 2 });
  // An answer whose question is no longer on the form (a re-scan reworded it).
  await upsertFieldAnswer({ awlId: AWL, linkId: linkA, fieldKey: 'verify_sponsorship', questionText: 'Do you now or will you in the future require sponsorship?', fieldType: 'radio', options: ['Yes', 'No'], value: 'No', source: 'deterministic', sortOrder: 3 });

  const questions = await buildReviewQuestions(AWL, linkA);
  check('the pane shows every question the FORM asks, not just the answered ones',
    questions.filter((r) => !r.stale).length === 3, `${questions.length} row(s) for 3 question(s)`);
  const gender = questions.find((r) => r.field_key === fieldKeyOf(qGender));
  check('an unanswered question still reaches the CA with its type + options',
    gender?.field_type === 'radio' && gender.options.length === 3 && gender.source === 'needs_input' && gender.value === null,
    `${gender?.field_type}/${gender?.source}`);
  check('the form\'s required marker decides what blocks APPLY', gender?.required === 1 && questions.find((r) => r.field_key === fieldKeyOf(qName))?.required === 1);
  check('a "[Optional]" prefix never blocks, and a NULL marker does',
    questionIsOptional({ required: null, question_text: qLinkedin }) && !questionIsOptional({ required: null, question_text: qGender }));
  check('an answer whose question left the form is flagged stale, not dropped',
    questions.some((r) => r.stale && r.field_key === 'verify_sponsorship' && r.value === 'No'));
  check('a required question nobody answered blocks APPLY', await hasBlockingMissingFacts(AWL, linkA));
  // The CA typing into a box the draft never wrote must create the row, or the
  // gate would lock with no way out.
  const created = await applyCaEdits(AWL, linkA, { [fieldKeyOf(qGender)]: 'Female' });
  check('a CA answer to a question with no row is stored', created === 1 && !(await hasBlockingMissingFacts(AWL, linkA)),
    'APPLY unlocked once the pane was completed');
  const answered = await listFieldAnswers(AWL, linkA);
  check('questions are answered from the applicant row alone', answered.length === 4 && Boolean(answered.find((r) => r.value)), `${answered.length} row(s)`);

  // The run succeeded: evidence + reason are persisted, then the data goes.
  await db.prepare(`UPDATE applications SET status = 'SUCCESS', screenshot_path = ?, screenshots_json = ?, fail_reason = NULL WHERE id = ?`)
    .run('https://cdn.example/public/ack.png', JSON.stringify({ pre_submit: 'https://cdn.example/public/pre.png', acknowledgement: 'https://cdn.example/public/ack.png' }), appA);
  const purge = await purgeApplicantFormData(AWL, linkA, appA);
  check('the (applicant, link) answers are erased', purge.answersRemoved === 4 && (await listFieldAnswers(AWL, linkA)).length === 0, `${purge.answersRemoved} row(s)`);
  check('the shared profile survives while another link is open', !purge.profileCleared && !(await applicantNeedsProfile(AWL)));
  const kept = await db.prepare('SELECT status, fail_reason, screenshot_path, screenshots_json, purged_at FROM applications WHERE id = ?').get(appA);
  check('status + screenshot URLs + purged_at survive the erase',
    kept.status === 'SUCCESS' && Boolean(kept.screenshot_path) && String(kept.screenshots_json).includes('pre_submit') && Boolean(kept.purged_at));

  await db.prepare("UPDATE applications SET status = 'FAILED', fail_reason = 'verify: validation banner text' WHERE id = ?").run(appB);
  const purge2 = await purgeApplicantFormData(AWL, linkB, appB);
  check('with nothing open the profile itself is cleared', purge2.profileCleared && (await applicantNeedsProfile(AWL)));
  const keptB = await db.prepare('SELECT status, fail_reason FROM applications WHERE id = ?').get(appB);
  check('a failed run keeps its reason for the CA and DEV', keptB.status === 'FAILED' && /validation banner/.test(keptB.fail_reason || ''));
  return { appA };
}

/* --------------------- location shapes + record map ------------------ */

// The CRM stores every applicant's location in three separate columns and the
// form asks for exactly one shape. Filling a ZIP box with "Raleigh, North
// Carolina" is a wrong answer no submit gate ever catches, so the rule reads the
// SHAPE off the question and abstains when that shape is not on record.
const { buildRecordMap, resolveDerived } = __internals;
const box = (question, kind = 'text') => ({
  kind, type: kind, questionText: question, label: '', name: '', id: '',
  placeholder: '', ariaLabel: '', options: []
});
const THREE_FORMS = {
  state_of_residence: 'Raleigh, North Carolina',
  zip_or_country: '27601',
  full_address: '100 Warm Springs Ct, Raleigh, NC 27601'
};
function shapeCheck(label, rawClient, question, expected) {
  const map = buildRecordMap({ raw: { client: rawClient, additional_information: {} } });
  const got = resolveDerived(box(question), map, {}) || '';
  check(label, got === expected, `got ${JSON.stringify(String(got).slice(0, 40))}`);
}

async function verifyLocationShapes() {
  step('3b. one location question, three record shapes');
  shapeCheck('a bare "Location" box takes the residence shape', THREE_FORMS,
    'Which of the following locations best describes yours?', THREE_FORMS.state_of_residence);
  shapeCheck('a ZIP box takes the ZIP, never the residence', THREE_FORMS,
    'What is your ZIP code?', THREE_FORMS.zip_or_country);
  shapeCheck('a full-address box takes the street address', THREE_FORMS,
    'Please enter your full address.', THREE_FORMS.full_address);
  shapeCheck('a postal-code box is not fooled by the word "address"', THREE_FORMS,
    'Mailing address postal code', THREE_FORMS.zip_or_country);
  shapeCheck('a country question never receives the ZIP', THREE_FORMS,
    'Which country are you currently based in?', '');
  shapeCheck('a missing shape abstains instead of guessing', { state_of_residence: 'Raleigh, North Carolina' },
    'What is your ZIP code?', '');
  shapeCheck('a country name answers a country question', { zip_or_country: 'United States' },
    'Which country are you in?', 'United States');
  shapeCheck('an email box is not a postal address', THREE_FORMS, 'What is your email address?', '');
}

async function verifyDevLog(appA) {
  step('4. DEV activity feed');
  const types = ['applicant_profile_fetched', 'link_scan_start', 'link_scan_done', 'draft_pass', 'ca_answers_edited', 'screenshots_uploaded', 'applicant_data_purged', 'run_success'];
  for (const t of types) await logEvent(appA, t, 'verify', { probe: t });
  // One probe per type: the prefix filter is what the DEV dropdown uses, so it
  // must find the event AND must not leak unrelated stages into the result.
  let missing = [];
  for (const t of types) {
    // Match OUR row, not merely "a row of this type": on a shared database live
    // CA traffic outranks a fixture inside any newest-N window.
    const rows = await listEvents({ limit: 100, type: t });
    if (!rows.some((r) => r.type === t && Number(r.application_id) === Number(appA))) missing.push(t);
  }
  check('every stage of the pipeline emits an event', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : `${types.length} types`);
  const shots = await listEvents({ limit: 100, type: 'screenshots' });
  check('the feed filters by stage (type=screenshots)',
    shots.some((e) => Number(e.application_id) === Number(appA)) && shots.every((e) => e.type.startsWith('screenshots')), `${shots.length} row(s)`);
  const scan = await listEvents({ limit: 50, type: 'link_scan' });
  check('one prefix covers a whole worker (type=link_scan)', scan.length >= 2 && scan.every((e) => e.type.startsWith('link_scan')), `${scan.length} row(s)`);
  // Scoped to OUR application. "The newest 10 of this type" is a race with live
  // traffic on a shared database: real CAs edit answers while this runs, and
  // losing that race would say nothing about the contract being checked here.
  const feed = await listEvents({ limit: 200, type: 'ca_answers_edited' });
  const ctx = feed.filter((e) => Number(e.application_id) === Number(appA));
  check('the feed carries the AWL-ID + link context',
    ctx.length > 0 && ctx.every((e) => e.awl_id === AWL && e.company === 'Verify Co'),
    ctx.length ? `${ctx.length} row(s): awl=${ctx[0].awl_id}, company=${ctx[0].company}` : 'our application produced no ca_answers_edited row in the newest 200');
}

/* --------------------- .csv / paste ingestion parser -----------------
   Pure parser assertions (no writes): the DEV tab hands a whole uploaded file
   to the same function a pasted block goes through, so these shapes are the
   ingest contract. A row that is guessed wrong applies a real person to the
   wrong job, hence the "must be skipped, not inferred" checks. */
async function verifyCsvParser() {
  step('5. Job-link table parser (.csv upload + paste)');
  const { parseAwlLinkTable } = await import('../core/joblink-csv.js');
  const U1 = 'https://jobs.ashbyhq.com/acme/3f2b1c9a-0000-4000-8000-000000000001';
  const U2 = 'https://jobs.ashbyhq.com/acme/3f2b1c9a-0000-4000-8000-000000000002';

  const headed = parseAwlLinkTable(
    `applywizz_id,job_link,company,title\nAWL-101,${U1},Acme,Staff Engineer\n102,${U2}?src=Linkedin,Acme,"Data, Infra"\n`);
  check('a header row is consumed, not ingested', headed.pairs.length === 2 && headed.header, `${headed.pairs.length} pair(s)`);
  check('a bare numeric id is keyed exactly as the CRM keys it', headed.pairs[1]?.awlId === '102', headed.pairs[1]?.awlId);
  check('tracking params collapse to one link', headed.pairs[1]?.url === U2, headed.pairs[1]?.url);
  check('company + title columns are carried', headed.pairs[1]?.title === 'Data, Infra', headed.pairs[1]?.title);

  const priority = parseAwlLinkTable(`id,applywizz_id,url\n999,AWL-201,${U1}\n`);
  check('the specific id column beats a generic "id"', priority.pairs[0]?.awlId === 'AWL-201', priority.pairs[0]?.awlId);

  const quoted = parseAwlLinkTable(`awl,job link\nAWL-202,"${U1}"\nAWL-203,"${U2}","note with ""quotes"""\n`);
  check('quoted cells (and "" escapes) parse', quoted.pairs.length === 2 && quoted.pairs[0].url === U1, `${quoted.pairs.length} pair(s)`);

  const tsv = parseAwlLinkTable(`awl_id\tjob_link\nAWL-204\t${U1}\n`);
  check('a TSV export parses', tsv.pairs[0]?.awlId === 'AWL-204' && tsv.pairs[0]?.url === U1, `${tsv.pairs.length} pair(s)`);

  const commented = parseAwlLinkTable(`# exported from the CRM\nawl_id,job_link\nAWL-205,${U1}\n`);
  check('a leading comment does not hide the header', commented.header && commented.pairs.length === 1 && !commented.skipped.length,
    `${commented.pairs.length} pair(s), ${commented.skipped.length} skipped`);

  const pasted = parseAwlLinkTable(
    `# pasted from the CRM\nAWL-101   ${U1}\nawl102 | ${U2}\n\nAWL-101   ${U1}?source=linkedin\n`);
  check('header-less pasted lines match by shape', pasted.pairs.length === 2, `${pasted.pairs.length} pair(s)`);
  check('comments are ignored and repeats deduped', !pasted.skipped.length && pasted.pairs.every((p) => p.awlId !== 'IGNORED'));

  const bad = parseAwlLinkTable(`awl_id,job_link\nAWL-301,not-a-url\nsee notes,${U1}\n,,\n`);
  check('a row without a real link is skipped', bad.skipped.some((s) => s.reason === 'no http(s) job link'), JSON.stringify(bad.skipped));
  check('prose in the id column is skipped, not guessed', bad.skipped.some((s) => /not an id/.test(s.reason)), JSON.stringify(bad.skipped));
  check('an empty row is dropped silently', bad.pairs.length === 0 && !bad.skipped.some((s) => s.line === 4));
}

async function verifyCrmFetch() {
  step('6. CRM fetch (--crm only; needs the Azure connection)');
  const { isConfigured, syncApplicantByAwl } = await import('../connector/applicant-db.js');
  if (!isConfigured()) { console.log('  SKIP  PG_* not configured'); return; }
  const summary = await syncApplicantByAwl(AWL);
  check('a lookup by AWL-ID alone completes', summary?.seen === 0, `seen ${summary?.seen} (0 = the synthetic id is correctly absent)`);
}

/* -------------------------------- run ------------------------------- */

console.log(`Flow verifier — backend: ${BACKEND}`);
await migrate();
try {
  await verifySchema();
  await verifyScanQueue();
  await verifyCapabilityGate();
  const { appA } = await verifyApplicantAndPurge();
  await verifyHandBack(appA);
  await verifyLocationShapes();
  await verifyDevLog(appA);
  await verifyCsvParser();
  if (process.argv.includes('--crm')) await verifyCrmFetch();
} catch (err) {
  failed += 1;
  console.error('\n  EXCEPTION', err);
} finally {
  await cleanup().catch((e) => console.error('cleanup:', e.message));
  const left = await db.prepare('SELECT COUNT(1) AS n FROM applicants WHERE awl_id = ?').get(AWL);
  check('synthetic fixture removed again', !Number(left?.n || 0));
}
console.log(`\n${failed ? 'FAILED' : 'PASSED'} — ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
