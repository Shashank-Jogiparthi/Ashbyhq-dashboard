/* =====================================================================
   HOST CAPACITY — how many browsers THIS machine can actually hold.

   MAX_CONCURRENT_RUNS=4 is a promise about the machine, and until now
   nothing checked that the machine agreed. On the Railway deploy three
   applications were claimed by one poll tick and launched together; the
   Drata run died six seconds later having written no result and captured
   no screenshot, while its two siblings ran the full 90 seconds and
   submitted. That is the signature of the kernel taking a Chromium down
   because the container ran out of memory — a machine fault that got
   filed as an applicant's FAILED application.

   So the number of browsers is now measured, not assumed:

     bytes available / bytes per browser   (default 512MB)

   "bytes available" is read from the cgroup when one exists, because
   os.totalmem() inside a container reports the HOST's memory: a service
   limited to 512MB on an 8GB node would otherwise be told it can run
   sixteen browsers. cgroup v2 uses memory.max ("max" = no limit), v1 uses
   memory.limit_in_bytes (a huge sentinel = no limit). Only when neither
   file exists (a normal laptop) does the OS number get used.

   Every input is injectable so the arithmetic can be asserted without a
   container to test on, and two knobs override the measurement for an
   operator who knows better than the heuristic:
     MAX_BROWSERS     hard ceiling on browsers at once, this host
     HOST_MEM_MB      pretend the host has this much memory
     APPLY_BROWSER_MB bytes budgeted per browser (default 512)
   ===================================================================== */
import fs from 'node:fs';
import os from 'node:os';

const DEFAULT_BROWSER_MB = 512;
const CGROUP_FILES = [
  '/sys/fs/cgroup/memory.max',                       // v2 (unified)
  '/sys/fs/cgroup/memory/memory.limit_in_bytes'      // v1
];

/**
 * Memory this process is actually allowed to use, and where the number came
 * from. Never throws: an unreadable cgroup just falls through to the next
 * source, and os.totalmem() is always available.
 * @param {object} env
 * @returns {{bytes: number, source: string}}
 */
export function hostMemory(env = process.env) {
  const pretend = Number(env.HOST_MEM_MB);
  if (Number.isFinite(pretend) && pretend > 0) {
    return { bytes: Math.floor(pretend) * 1024 * 1024, source: 'HOST_MEM_MB (configured)' };
  }
  for (const file of CGROUP_FILES) {
    let raw = '';
    try { raw = String(fs.readFileSync(file, 'utf8')).trim(); } catch { continue; }
    if (!raw || raw === 'max') continue;                 // v2 spelling of "no limit"
    const n = Number(raw);
    // v1 writes ~9.2e18 for "no limit"; anything that large is not a real cap.
    if (!Number.isFinite(n) || n <= 0 || n > 1e15) continue;
    return { bytes: Math.floor(n), source: `cgroup limit (${file})` };
  }
  return { bytes: os.totalmem(), source: 'os.totalmem (no container limit found)' };
}

/**
 * How many browsers may run at once on this host.
 * @param {{env?: object, memory?: {bytes: number, source: string}}} opts
 * @returns {{capacity: number, fit: number, perBrowserBytes: number,
 *            memBytes: number, source: string, configured: boolean, reason: string}}
 */
export function browserCapacity({ env = process.env, memory = hostMemory(env) } = {}) {
  const perMb = Math.max(128, Number(env.APPLY_BROWSER_MB) || DEFAULT_BROWSER_MB);
  const perBrowserBytes = perMb * 1024 * 1024;
  // A host with less than one browser's worth of memory still has to be allowed
  // to do ONE at a time: a zero capacity would freeze the queue forever.
  const fit = Math.max(1, Math.floor(memory.bytes / perBrowserBytes));
  const explicit = Number(env.MAX_BROWSERS);
  const configured = Number.isFinite(explicit) && explicit >= 1;
  const capacity = configured ? Math.floor(explicit) : fit;
  const gb = (memory.bytes / (1024 * 1024 * 1024)).toFixed(memory.bytes / (1024 ** 3) < 10 ? 2 : 1);
  return {
    capacity,
    fit,
    perBrowserBytes,
    memBytes: memory.bytes,
    source: memory.source,
    configured,
    reason: configured
      ? `MAX_BROWSERS=${Math.floor(explicit)} (configured)`
      : `${capacity} browser(s) at ${perMb}MB in ${gb}GB available (${memory.source})`
  };
}

/**
 * An explicit per-worker number still wins, but never above what the host can
 * hold: an operator raising MAX_CONCURRENT_RUNS on a 512MB container is asking
 * for the OOM kill, and asking for it in the applicant's name. Infinity (the
 * worker's "unlimited") does NOT mean an unbounded number of browsers - it means
 * "however many this machine fits", which is what the measurement is for.
 * @param {number} wanted   the worker's own configured/default cap
 * @param {{capacity:number}} budget
 * @returns {{limit: number, capped: boolean}}
 */
export function effectiveLimit(wanted, budget = browserCapacity()) {
  const cap = Math.max(1, Math.floor(Number(budget.capacity) || 1));
  if (!Number.isFinite(wanted)) return { limit: cap, capped: false };   // unlimited = as many as fit
  const want = Math.max(1, Math.floor(wanted));
  const limit = Math.min(want, cap);
  return { limit, capped: limit < want };
}
