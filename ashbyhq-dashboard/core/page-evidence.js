/* =====================================================================
   PAGE EVIDENCE — one proof screenshot of a page that is NOT a form.

   WHY this lives beside the browser probe
   ---------------------------------------
   The submit engine owns the two evidence shots of a real application
   (pre-submit + acknowledgement) and is never edited. But a link that turns out
   to be a CLOSED / REMOVED posting never reaches an application at all, so the
   engine never runs on it and there is no screenshot to show the assigned CA.
   The one thing that settles "why can't I apply?" is a picture of the page that
   says so ("Job not found", "This posting has expired"), so this module loads
   the page once, headless, and captures exactly that.

   It is deliberately best-effort: a host that cannot launch a browser, a page
   that will not load, or Storage that is not configured must NEVER turn into a
   scan failure. Every problem is folded into the returned object; the caller
   still records the link as unavailable with the page's own words even when no
   image survives.

   Browser resolution mirrors core/browser-probe.js: CHROME_PATH if set, else
   Playwright's bundled Chromium, imported lazily so a machine without the
   library still loads this module.
   ===================================================================== */
import fs from 'fs';
import os from 'os';
import path from 'path';

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

/**
 * capturePageEvidence(url) -> { ok:true, filePath } | { ok:false, error }
 * A full-page PNG of `url` in an OS temp dir. The CALLER owns the file and must
 * delete it after uploading (nothing applicant-facing is left on disk).
 */
export async function capturePageEvidence(url, { log = () => {}, timeoutMs = 30_000 } = {}) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) return { ok: false, error: 'not an http(s) url' };

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    return { ok: false, error: `playwright unavailable: ${String(err?.message || err).slice(0, 120)}` };
  }
  if (!chromium) return { ok: false, error: 'playwright exported no chromium' };

  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: process.env.CHROME_PATH || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const context = await browser.newContext({
      viewport: { width: 1366, height: 900 },
      userAgent: UA,
      locale: 'en-US',
      timezoneId: 'America/New_York'
    });
    const page = await context.newPage();
    await page.goto(target, { waitUntil: 'domcontentloaded', timeout: timeoutMs });
    // Give the SPA a beat to render its "not found" state before the shot.
    await page.waitForTimeout(1500);
    const file = path.join(os.tmpdir(), `applywizz-evidence-${Date.now()}.png`);
    await page.screenshot({ path: file, fullPage: true });
    if (!fs.existsSync(file)) return { ok: false, error: 'screenshot produced no file' };
    log(`page evidence captured: ${file}`);
    return { ok: true, filePath: file };
  } catch (err) {
    return { ok: false, error: String(err?.message || err).slice(0, 200) };
  } finally {
    try { await browser?.close(); } catch { /* already gone */ }
  }
}
