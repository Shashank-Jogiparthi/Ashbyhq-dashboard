/* =====================================================================
   Human-behavior simulation layer.

   A single, reusable source of "how a person actually drives a browser":
     - curved cursor travel (cubic-bezier) with variable speed, jitter,
       and Fitts-style overshoot + correction, instead of a straight line
     - per-keystroke typing with word/punctuation pauses and thinking gaps
     - wheel scrolling in uneven ticks with read pauses
     - a behavioral "warm-up" after a page loads (wander + read) before any
       field is touched

   The goal is to make the automation's input timeline look like a real
   candidate rather than a script, which is what Ashby's edge/bot layer
   (Cloudflare + request verification) scores.

   Robustness rule: every action is best-effort. If a humanized gesture
   cannot be performed (element hidden, overlapped, no bounding box) the
   caller falls back to the plain Playwright action, so a run never breaks
   because of cosmetics. Set HUMANIZE=false to disable (instant actions).
   ===================================================================== */

const POINTER = new WeakMap(); // page -> { x, y } last known cursor position

export function enabled() {
  return process.env.HUMANIZE !== 'false';
}

export function rand(min, max) { return Math.random() * (max - min) + min; }
export function randInt(min, max) { return Math.floor(rand(min, max + 1)); }
export function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
export async function pause(page, min, max) { await sleep(enabled() ? randInt(min, max) : 0); }

function pointerPos(page, viewport) {
  const p = POINTER.get(page);
  if (p) return p;
  const w = (viewport && viewport.width) || 1280;
  const h = (viewport && viewport.height) || 800;
  const start = { x: rand(w * 0.2, w * 0.8), y: rand(h * 0.2, h * 0.8) };
  POINTER.set(page, start);
  return start;
}

function cubicBezier(p0, p1, p2, p3, t) {
  const mt = 1 - t;
  const a = mt * mt * mt, b = 3 * mt * mt * t, c = 3 * mt * t * t, d = t * t * t;
  return { x: a * p0.x + b * p1.x + c * p2.x + d * p3.x, y: a * p0.y + b * p1.y + c * p2.y + d * p3.y };
}

// Ease-in-out so the cursor accelerates mid-stroke and settles at the target.
function easeInOut(t) { return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2; }

/* Move the cursor to an absolute viewport point along a curved, jittered arc. */
export async function movePointer(page, to, opts = {}) {
  const from = pointerPos(page, page.viewportSize());
  POINTER.set(page, to);
  if (!enabled()) { await page.mouse.move(to.x, to.y); return; }

  const dx = to.x - from.x, dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const bow = Math.min(140, dist * 0.28) * (Math.random() < 0.5 ? -1 : 1);
  const nx = -dy / dist, ny = dx / dist; // unit normal for the arc's bow
  const c1 = { x: from.x + dx * 0.32 + nx * bow + rand(-18, 18), y: from.y + dy * 0.32 + ny * bow + rand(-18, 18) };
  const c2 = { x: from.x + dx * 0.70 + nx * bow * 0.45 + rand(-12, 12), y: from.y + dy * 0.70 + ny * bow * 0.45 + rand(-12, 12) };

  const steps = Math.max(14, Math.min(52, Math.round(dist / 11) + randInt(6, 16)));
  for (let i = 1; i <= steps; i += 1) {
    const e = easeInOut(i / steps);
    const p = cubicBezier(from, c1, c2, to, e);
    const jx = i < steps ? rand(-1.4, 1.4) : 0;
    const jy = i < steps ? rand(-1.4, 1.4) : 0;
    await page.mouse.move(p.x + jx, p.y + jy);
    await sleep(randInt(4, 16));
  }

  // Overshoot slightly past the target then correct back (very human for long moves).
  if (opts.overshoot !== false && dist > 220 && Math.random() < 0.45) {
    const ox = to.x + Math.sign(dx) * rand(8, 22) + rand(-8, 8);
    const oy = to.y + rand(-10, 10);
    await page.mouse.move(ox, oy);
    await sleep(randInt(24, 80));
    await page.mouse.move(to.x, to.y);
  }
  await sleep(randInt(30, 120));
}

/* Move onto a locator's box (randomised interior point, not the dead centre). */
export async function moveToLocator(page, locator, opts = {}) {
  const box = await locator.boundingBox().catch(() => null);
  if (!box) return false;
  const x = box.x + box.width * rand(0.35, 0.65) + (opts.offsetX || 0);
  const y = box.y + box.height * rand(0.35, 0.65) + (opts.offsetY || 0);
  await movePointer(page, { x, y }, opts);
  return true;
}

/* A real press: travel to the element, dwell, mouse-down (short hold), mouse-up. */
export async function humanClick(page, locator, opts = {}) {
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  const moved = await moveToLocator(page, locator, opts);
  if (!enabled()) { await locator.click({ force: opts.force ?? true }).catch(() => {}); return true; }
  if (moved) {
    await pause(page, 70, 220);
    await page.mouse.down();
    await sleep(randInt(45, 130)); // click hold-time
    await page.mouse.up();
    await pause(page, 140, 420);
    return true;
  }
  await locator.click({ force: true }).catch(() => {});
  return true;
}

/* Type text one character at a time with natural cadence + occasional pauses. */
export async function humanType(page, locator, text, opts = {}) {
  const str = String(text ?? '');
  if (!str) return false;
  await locator.scrollIntoViewIfNeeded().catch(() => {});
  if (!enabled()) { return locator.fill(str).then(() => true).catch(() => false); }

  await moveToLocator(page, locator, opts).catch(() => {});
  const focused = await locator.focus().then(() => true).catch(() => false);
  if (!focused) return false;

  // Clear any pre-filled value the way a person would (select-all + delete).
  const existing = await locator.inputValue().catch(() => '');
  if (existing) {
    await page.keyboard.press('Control+a').catch(() => {});
    await page.keyboard.press('Delete').catch(() => {});
    await pause(page, 90, 240);
  }

  for (const ch of str) {
    await page.keyboard.type(ch);
    let d = randInt(55, 165);
    if (ch === ' ') d += randInt(30, 120);
    if (/[.,;:!?\-]/.test(ch)) d += randInt(90, 240);
    await sleep(d);
    if (Math.random() < 0.05) await pause(page, 260, 720); // micro "thinking" gap
  }
  await pause(page, 160, 460);
  return true;
}

/* Scroll the wheel in uneven ticks, pausing to "read", with an occasional
   small scroll-back. deltaY>0 scrolls down. */
export async function humanScroll(page, deltaY = 420) {
  if (!enabled()) { await page.mouse.wheel(0, deltaY); return; }
  const ticks = randInt(2, 4);
  const per = deltaY / ticks;
  for (let i = 0; i < ticks; i += 1) {
    await page.mouse.wheel(0, Math.round(per + rand(-70, 70)));
    await pause(page, 260, 780);
  }
  if (Math.sign(deltaY) > 0 && Math.random() < 0.35) {
    await page.mouse.wheel(0, -randInt(120, 360)); // glance back up
    await pause(page, 220, 560);
  }
}

/* Behavioral warm-up right after a page loads: idle pointer wander + a read
   scroll, so the first real interaction isn't an instant teleport-and-click. */
export async function humanWarmup(page) {
  if (!enabled()) return;
  const vp = page.viewportSize() || { width: 1280, height: 800 };
  const stops = randInt(2, 4);
  for (let i = 0; i < stops; i += 1) {
    await movePointer(page, { x: rand(vp.width * 0.15, vp.width * 0.85), y: rand(vp.height * 0.2, vp.height * 0.8) }, { overshoot: false });
    await pause(page, 120, 420);
  }
  const ticks = randInt(2, 4);
  for (let i = 0; i < ticks; i += 1) {
    await page.mouse.wheel(0, randInt(220, 520));
    await pause(page, 360, 900);
  }
  if (Math.random() < 0.6) { await page.mouse.wheel(0, -randInt(160, 420)); await pause(page, 260, 620); }
  await pause(page, 500, 1400);
}
