/* =====================================================================
   BROWSER CAPABILITY GATE

   Both queues — `link_scan_jobs` and `applications` — live in a SHARED
   database. Whichever dashboard instance polls first takes the row, and until
   now no host ever asked itself whether it could actually do the work. A
   Railway container with no Chromium claimed five pre-scans and two CA apply
   runs and turned all seven into FAILED rows, and the scans that were ALREADY
   cached looked like successes on the same machine (an 8s "✓ scanned"), so the
   pane gave no signal that the host was broken.

   The fix cannot be "set WORKER_ENABLED=false on that container": the next
   browserless host has not been created yet. So the host is asked, in the only
   way that is not a guess — start a browser, open a page, shut it down — and a
   host that fails that test does not claim browser work at all.

   Consequences a reader should know:
     * The answer is per HOST and per MODE, and is never written to the shared
       database.
     * MODES ARE NOT INTERCHANGEABLE, and that was a live bug. The engine applies
       HEADED (a real window is the best signal available to Ashby's anti-spam
       filter) and scans HEADLESS. A container with no display can therefore be
       perfectly capable for scans and incapable for applies - and a single
       headless-only probe used to call such a container "ready", after which
       the apply worker claimed CA applications and lost them to
       `browserType.launch: Target page, context or browser has been closed`.
       So there are two verdicts, each measured in the mode that worker uses.
     * It is re-checked every BROWSER_RECHECK_MS (default 10m), so installing a
       browser (or giving a host a display) starts work again without a redeploy,
       and a host that loses its browser stops claiming without one.
     * The scan worker is softer than the apply worker: a link can still be
       answered from the local or shared cache with no browser at all, so a
       browserless host may resolve those rows but DEFERS the ones that need a
       window, without spending an attempt on them.
   ===================================================================== */
import { spawn } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const PROBE = path.join(HERE, 'browser-probe.js');
// The probe prefixes its answer with this, because stdout is shared with dotenv's
// startup banner and any other library that likes to talk.
const MARKER = 'BROWSER_PROBE';

// Re-check cadence. Long enough that a browserless host costs one child process
// every few minutes instead of one per 8s poll, short enough that installing a
// browser takes effect on its own.
const RECHECK_MS = Math.max(60_000, Number(process.env.BROWSER_RECHECK_MS || 10 * 60 * 1000));
// A cold first launch on Windows can take several seconds; a container that is
// out of shared memory can hang rather than fail. Either way, unknown is NOT
// capable, so the default is a refusal.
const PROBE_TIMEOUT_MS = Math.max(10_000, Number(process.env.BROWSER_PROBE_TIMEOUT_MS || 90_000));

// One verdict per MODE, because "can this host open a window?" and "can this
// host load a page invisibly?" have different answers on a display-less
// container. 'apply' is the default everywhere it is not passed explicitly: the
// stricter, destructive question wins when the caller is vague.
const MODES = new Map();
const modeKey = (m) => (m === 'scan' ? 'scan' : 'apply');
const freshState = () => ({
  ok: false, checked: false, exec: null, mode: 'apply',
  note: 'browser check has not run yet', host: os.hostname(), checkedAt: 0
});
MODES.set('apply', { ...freshState(), mode: 'apply' });
MODES.set('scan', { ...freshState(), mode: 'scan' });
const inflightByMode = new Map();

/** Last known answer for a mode, synchronously — worker ticks read this before claiming. */
export function browserState(mode = 'apply') {
  return MODES.get(modeKey(mode));
}

/** Both verdicts, for a status surface that must explain a host completely. */
export function browserStates() {
  return { apply: MODES.get('apply'), scan: MODES.get('scan') };
}

/** True only when a probe has actually started a browser in THIS mode on this host. */
export function canDriveBrowsers(mode = 'apply') {
  const s = browserState(mode);
  return s.checked && s.ok;
}

/**
 * Ask the host whether it can drive a browser in `mode`. Throttled and
 * de-duplicated per mode: it is safe to call from every worker tick, and `force`
 * is for the moments where a human has just changed something (DEV "re-check",
 * a run that died on the launch anyway).
 */
export function checkBrowser({ force = false, mode = 'apply' } = {}) {
  const key = modeKey(mode);
  const state = MODES.get(key);
  if (inflightByMode.get(key)) return inflightByMode.get(key);
  if (!force && state.checked && Date.now() - state.checkedAt < RECHECK_MS) return Promise.resolve(state);

  const run = runProbe(key)
    .then((next) => settle(key, next))
    .catch((err) => settle(key, {
      ...MODES.get(key),
      ok: false,
      checked: true,
      note: `browser probe errored: ${String(err?.message || err).slice(0, 200)}`,
      checkedAt: Date.now()
    }))
    .finally(() => { inflightByMode.delete(key); });
  inflightByMode.set(key, run);
  return run;
}

function settle(key, next) {
  const before = MODES.get(key);
  MODES.set(key, next);
  // Loud once, then only when the answer changes: this is the line that explains
  // why a queue is not moving, so it must survive being buried in server logs.
  if (!before.checked) {
    console.log(next.ok
      ? `Browser ready on ${next.host} for ${key} runs: ${next.note}`
      : `NO BROWSER for ${key} runs on ${next.host} (${next.note}) — this host will not claim ${key === 'scan' ? 'scans that need a page load' : 'apply runs'}; that work stays queued for a machine that can drive a browser in this mode.`);
  } else if (before.ok !== next.ok) {
    console.log(next.ok
      ? `Browser became AVAILABLE for ${key} runs on ${next.host}: ${next.note} — claiming that work again.`
      : `Browser became UNAVAILABLE for ${key} runs on ${next.host}: ${next.note} — claiming that work is paused.`);
  }
  return next;
}

function report(ok, note, exec = null, mode = 'apply') {
  return { ok, checked: true, exec, mode, note: String(note).slice(0, 300), host: os.hostname(), checkedAt: Date.now() };
}

function runProbe(mode) {
  // Every answer this promise produces belongs to one mode, so stamp them all
  // through one helper instead of relying on report()'s default.
  const rep = (ok, note, exec = null) => report(ok, note, exec, mode);
  return new Promise((resolve) => {
    let child;
    try {
      // argv carries the mode: the probe must launch the way THIS worker's
      // engine path does, not "a browser" in the abstract.
      child = spawn(process.execPath, [PROBE, mode], {
        cwd: HERE,
        // The probe resolves Playwright and CHROME_PATH the same way the engine's
        // parent does, so inherit the environment untouched. The two quiet flags
        // are for the two dotenv flavours in use; neither is trusted to keep
        // stdout clean — the MARKER below is what does that.
        env: { ...process.env, DOTENV_CONFIG_QUIET: 'true', DOTENV_LOG: 'quiet' },
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch (err) {
      resolve(rep(false, `could not run the browser probe: ${String(err?.message || err).slice(0, 200)}`));
      return;
    }

    let buf = '';
    let done = false;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* already gone */ }
      resolve(result);
    };
    const timer = setTimeout(() => {
      finish(rep(false, `the browser probe never answered within ${Math.round(PROBE_TIMEOUT_MS / 1000)}s`));
    }, PROBE_TIMEOUT_MS);
    timer.unref?.();

    // Find OUR line, wherever it is. Assuming "first line of stdout" was the old
    // bug class entirely: dotenv writes an "injected env" banner there, which is
    // not an answer about browsers.
    const scan = () => {
      // Only ever read COMPLETE lines: a marker that arrives half-finished would
      // otherwise report a truncated browser path as a healthy answer.
      const complete = buf.endsWith('\n') ? buf : buf.slice(0, buf.lastIndexOf('\n') + 1);
      for (const raw of complete.split('\n')) {
        if (!raw.startsWith(MARKER)) continue;
        const [, tag = '', ...fields] = raw.trimEnd().split('\t');
        const detail = String(fields[0] || '').trim();
        if (tag === 'OK') finish(rep(true, `${detail}${fields[1] ? ` (${fields[1]})` : ''}`, detail || null));
        else if (tag === 'MISSING') finish(rep(false, `no browser executable at ${detail || '?'}`));
        else if (tag === 'NOLOAD') finish(rep(false, `Playwright is not installed here (${detail || 'import failed'})`));
        else if (tag === 'NOEXEC') finish(rep(false, detail || 'Playwright could not name a browser path'));
        else if (tag === 'LAUNCHFAIL') finish(rep(false, `browser exists but refused to start: ${detail}`));
        else finish(rep(false, `unknown probe answer "${(tag || raw).slice(0, 160)}"`));
        return true;
      }
      return false;
    };

    child.stdout.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 64_000) buf = buf.slice(-32_000);   // bounded, marker survives
      scan();
    });
    child.on('error', (err) => finish(rep(false, `browser probe could not run: ${String(err?.message || err).slice(0, 200)}`)));
    child.on('exit', (code) => {
      if (done || scan()) return;
      const noise = buf.trim().split('\n').filter(Boolean).slice(-1)[0] || '';
      finish(rep(false, `browser probe exited (${code ?? 'killed'}) without answering${noise ? `; last output: ${noise.slice(0, 160)}` : ''}`));
    });
  });
}
