/* =====================================================================
   APPLY LAUNCH MODE — one rule, asked in three places.

   The engine opens a HEADED window for an application unless
   `APPLY_HEADLESS=true` (or `HEADLESS=true`): a real window on a real
   desktop is the best signal available to Ashby's anti-spam filter, and
   the engine's own comment calls headless "a throughput tradeoff, not a
   free win". That is the right default on a laptop and impossible on a
   container with no display, where headed launch dies with
   `browserType.launch: Target page, context or browser has been closed`.

   Before this file existed, three different places each re-derived that
   answer from the environment by hand, and they disagreed:
     * the engine (root ashby-hybrid-automation.js) read only the two
       variables, so on Railway it tried to open a window and died;
     * the capability probe launched headless, so it reported the very
       same host as READY;
     * the worker's status pane said "headed (visible)" about a machine
       that had no display to make visible.
   A false READY is the exact bug class the gate was written to stop, and
   it came from within the gate. So the rule lives here once:

     explicit APPLY_HEADLESS / HEADLESS  ->  that, always
     nothing set + linux with no DISPLAY/WAYLAND_DISPLAY  ->  headless
     anything else (macOS, Windows, a box with xvfb)      ->  headed

   An explicit value still wins in both directions: `APPLY_HEADLESS=false`
   on a server means "I have a display, give me the window", and if that
   turns out to be untrue the probe fails, the gate pins the host off, and
   the applications stay queued. Auto-detection only ever fills the gap
   nobody configured.

   This module is imported by the probe and the worker; the engine is NOT
   modified (long-standing rule: the base automation stays untouched). The
   worker instead passes the resolved answer to the child in its
   environment, which the engine already reads as APPLY_HEADLESS.
   ===================================================================== */

const truthy = (v) => String(v ?? '').trim().toLowerCase() === 'true';
const falsy = (v) => String(v ?? '').trim().toLowerCase() === 'false';

/**
 * Decide how an APPLY run must launch on THIS host.
 * @param {object} env   environment (defaults to process.env)
 * @param {string} platform  os.platform() (defaults to this machine's)
 * @returns {{headless: boolean, explicit: boolean, reason: string, hint?: string}}
 */
export function applyLaunchMode(env = process.env, platform = process.platform) {
  const wants = env.APPLY_HEADLESS ?? env.HEADLESS;   // HEADLESS is the engine's alias
  if (truthy(wants)) return { headless: true, explicit: true, reason: 'APPLY_HEADLESS=true' };
  if (falsy(wants)) return { headless: false, explicit: true, reason: 'APPLY_HEADLESS=false (an operator asked for a real window)' };

  // Linux with no DISPLAY and no Wayland socket has no way to show a window:
  // Railway, Codespaces-style containers, CI, a headless VPS. Note that
  // WAYLAND_DISPLAY matters too - a Wayland-only desktop has no DISPLAY and
  // would otherwise be wrongly forced hidden.
  const display = String(env.DISPLAY || '').trim() || String(env.WAYLAND_DISPLAY || '').trim();
  if (platform === 'linux' && !display) {
    return {
      headless: true,
      explicit: false,
      reason: 'no display on this linux host',
      hint: 'set APPLY_HEADLESS=false and provide xvfb if these runs should open a real window'
    };
  }
  return { headless: false, explicit: false, reason: 'a desktop host is available', hint: 'set APPLY_HEADLESS=true to trade the window for throughput' };
}

/** Convenience for log lines and the DEV pane: one short phrase. */
export function applyLaunchLabel(mode = applyLaunchMode()) {
  return `${mode.headless ? 'headless' : 'headed'} (${mode.explicit ? 'configured' : mode.reason})`;
}
