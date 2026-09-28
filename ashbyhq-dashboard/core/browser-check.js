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
     * The answer is per HOST, like WORKER_ENABLED=false, and is never written
       to the shared database.
     * It is re-checked every BROWSER_RECHECK_MS (default 10m), so installing a
       browser on a running host starts work again without a redeploy, and a
       host that loses its browser stops claiming without one.
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

let state = { ok: false, checked: false, exec: null, note: 'browser check has not run yet', host: os.hostname(), checkedAt: 0 };
let inflight = null;

/** Last known answer, synchronously — worker ticks read this before claiming. */
export function browserState() {
  return state;
}

/** True only when a probe has actually started a browser on this host. */
export function canDriveBrowsers() {
  return state.checked && state.ok;
}

/**
 * Ask the host whether it can drive a browser. Throttled and de-duplicated: it
 * is safe to call from every worker tick, and `force` is for the moments where
 * a human has just changed something (DEV "re-check", worker enable).
 */
export function checkBrowser({ force = false } = {}) {
  if (inflight) return inflight;
  if (!force && state.checked && Date.now() - state.checkedAt < RECHECK_MS) return Promise.resolve(state);

  inflight = runProbe()
    .then((next) => settle(next))
    .catch((err) => settle({
      ...state,
      ok: false,
      checked: true,
      note: `browser probe errored: ${String(err?.message || err).slice(0, 200)}`,
      checkedAt: Date.now()
    }))
    .finally(() => { inflight = null; });
  return inflight;
}

function settle(next) {
  const before = state;
  state = next;
  // Loud once, then only when the answer changes: this is the line that explains
  // why a queue is not moving, so it must survive being buried in server logs.
  if (!before.checked) {
    console.log(next.ok
      ? `Browser ready on ${next.host}: ${next.note}`
      : `NO BROWSER on ${next.host} (${next.note}) — this host will not claim scans that need a window or apply runs. The queue stays for a machine that can drive a browser.`);
  } else if (before.ok !== next.ok) {
    console.log(next.ok
      ? `Browser became AVAILABLE on ${next.host}: ${next.note} — claiming browser work again.`
      : `Browser became UNAVAILABLE on ${next.host}: ${next.note} — claiming browser work is paused.`);
  }
  return state;
}

function report(ok, note, exec = null) {
  return { ok, checked: true, exec, note: String(note).slice(0, 300), host: os.hostname(), checkedAt: Date.now() };
}

function runProbe() {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(process.execPath, [PROBE], {
        cwd: HERE,
        // The probe resolves Playwright and CHROME_PATH the same way the engine's
        // parent does, so inherit the environment untouched. The two quiet flags
        // are for the two dotenv flavours in use; neither is trusted to keep
        // stdout clean — the MARKER below is what does that.
        env: { ...process.env, DOTENV_CONFIG_QUIET: 'true', DOTENV_LOG: 'quiet' },
        stdio: ['ignore', 'pipe', 'ignore']
      });
    } catch (err) {
      resolve(report(false, `could not run the browser probe: ${String(err?.message || err).slice(0, 200)}`));
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
      finish(report(false, `the browser probe never answered within ${Math.round(PROBE_TIMEOUT_MS / 1000)}s`));
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
        if (tag === 'OK') finish(report(true, `${detail}${fields[1] ? ` (${fields[1]})` : ''}`, detail || null));
        else if (tag === 'MISSING') finish(report(false, `no browser executable at ${detail || '?'}`));
        else if (tag === 'NOLOAD') finish(report(false, `Playwright is not installed here (${detail || 'import failed'})`));
        else if (tag === 'NOEXEC') finish(report(false, detail || 'Playwright could not name a browser path'));
        else if (tag === 'LAUNCHFAIL') finish(report(false, `browser exists but refused to start: ${detail}`));
        else finish(report(false, `unknown probe answer "${(tag || raw).slice(0, 160)}"`));
        return true;
      }
      return false;
    };

    child.stdout.on('data', (chunk) => {
      buf += chunk;
      if (buf.length > 64_000) buf = buf.slice(-32_000);   // bounded, marker survives
      scan();
    });
    child.on('error', (err) => finish(report(false, `browser probe could not run: ${String(err?.message || err).slice(0, 200)}`)));
    child.on('exit', (code) => {
      if (done || scan()) return;
      const noise = buf.trim().split('\n').filter(Boolean).slice(-1)[0] || '';
      finish(report(false, `browser probe exited (${code ?? 'killed'}) without answering${noise ? `; last output: ${noise.slice(0, 160)}` : ''}`));
    });
  });
}
