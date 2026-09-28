/* =====================================================================
   RUN FAULT CLASSIFICATION — whose failure is this?

   Two answers have been wrongly given to that question, both at the
   applicant's expense:

     1. A container with no browser claimed real applications and filed
        them FAILED with "Executable doesn't exist at /root/.cache/…". The
        machine's missing binary became a human's rejection record.
     2. After the browser was installed, three applications launched at
        once on a small container and one died six seconds in — no result
        JSON, no screenshot, nothing on output — while its two siblings
        submitted normally. That was reported as
        "Engine process exited without a result" and filed FAILED, again
        against the applicant, for a run that never actually happened.

   The rule both cases point at: an application may only be marked FAILED
   on evidence that the FORM was reached. The engine writes a job-status
   JSON whenever it gets that far, and captures screenshots whenever it
   gets that far. No result plus a process that was killed, or that said
   nothing at all, is not a decision about the applicant — it is a machine
   that could not do the work. That work goes back to the queue (parked for
   APPLY_DEFER_MS by handBackToQueue) instead of being recorded as a
   rejection.

   Kept as a pure function so verify:flow can assert every branch,
   including the ones that need a killed process to produce.
   ===================================================================== */

// Signatures of "this machine could not produce a browser at all", as opposed to
// "the automation tried and something on the page went wrong".
export const NO_BROWSER_SIG = /Executable doesn't exist|Please run the following command to download new browsers|Failed to launch the browser process|error while loading shared libraries|browserType\.launch/i;

const lastMeaningfulLine = (output) => String(output || '')
  .split('\n').map((l) => l.trim()).filter(Boolean).pop() || '';

/**
 * @param {object} r
 * @param {boolean} r.hasResult    the engine wrote a job-status JSON
 * @param {string}  [r.outcome]    the mapped outcome ('success' wins outright)
 * @param {number|null} r.exitCode child exit code (null when killed by a signal)
 * @param {string|null} r.exitSignal child signal name, if any
 * @param {string}  r.output       everything the engine printed
 * @param {number}  [r.concurrent] browsers this host had in flight at the time
 * @returns {{hostFault: boolean, reason: string, engineError: string}}
 */
export function classifyRunFault({ hasResult = false, outcome = '', exitCode = null,
  exitSignal = null, output = '', concurrent = 1 } = {}) {
  const engineError = lastMeaningfulLine(output);

  // The engine reached the page and judged it: the applicant's outcome stands,
  // whatever the process did afterwards.
  if (outcome === 'success') return { hostFault: false, reason: '', engineError };

  if (NO_BROWSER_SIG.test(String(output || ''))) {
    const line = String(output).split('\n').map((l) => l.trim()).find((l) => NO_BROWSER_SIG.test(l)) || 'browser unavailable';
    return { hostFault: true, reason: line.slice(0, 300), engineError };
  }

  // Killed by the kernel (137 = SIGKILL, 143 = SIGTERM, plus the signal Node
  // reports directly) with nothing written: the run was ended from outside, so
  // it decided nothing about this application.
  const killed = Boolean(exitSignal) || exitCode === 137 || exitCode === 143;
  if (!hasResult && killed) {
    const how = exitSignal ? `signal ${exitSignal}` : `exit code ${exitCode}`;
    return {
      hostFault: true,
      reason: `Engine killed by ${how} with no result after ${concurrent} browser(s) in flight on this host (out of memory?) - nothing was submitted`.slice(0, 300),
      engineError
    };
  }

  // No result and no output at all: equally no evidence anything was attempted.
  if (!hasResult && !String(output || '').trim()) {
    return { hostFault: true, reason: 'Engine exited without a result or any output - no attempt recorded', engineError: '' };
  }

  // Everything else is a real run: keep the engine's own words as the reason
  // instead of the generic sentence that made #62 undiagnosable.
  return {
    hostFault: false,
    reason: hasResult ? '' : (engineError || 'Engine process exited without a result'),
    engineError
  };
}
