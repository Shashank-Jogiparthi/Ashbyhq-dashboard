#!/usr/bin/env node
/* =====================================================================
   BROWSER PROBE — the truth about whether THIS machine can drive a browser.

   Answers with ONE marker line, TAB-separated (a browser path on Windows is
   full of spaces, so not spaces), prefixed so the reader can pick it out of
   anything else written to stdout:

     BROWSER_PROBE\tOK\t<executable>\t<version>       a browser started and a page opened
     BROWSER_PROBE\tMISSING\t<path>                  the executable the engine would use is absent
     BROWSER_PROBE\tNOLOAD\t<msg>                    Playwright itself is not installed here
     BROWSER_PROBE\tNOEXEC\t<msg>                    Playwright cannot name a browser path
     BROWSER_PROBE\tLAUNCHFAIL\t<msg>                the binary exists but refuses to start
                                                     (no system libs, sandbox, no /dev/shm)

   Why actually launch instead of checking that a file exists: the failure this
   guard was written against was exactly "the host looked capable and was not".
   On Railway the automation died with
   `Executable doesn't exist at /root/.cache/ms-playwright/chromium-1243/…`,
   because the image installs the Playwright *library* and nothing ever runs
   `npx playwright install`. An existsSync() check would have caught that one,
   but not the next variant (no libnss3, no shared memory, a read-only FS), and a
   probe that reports a false READY makes the same mess again. Starting a browser
   and closing it is the only honest answer.

   Nothing external is contacted: the page is about:blank.
   ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

// The engine reads CHROME_PATH from the repo-root .env, and so does the server.
// This probe can be run on its own (by a check, by a script, by a human), so it
// loads the same two files. dotenv never overwrites an existing key, so an
// already-loaded environment keeps its values.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const DASHBOARD = path.resolve(HERE, '..');
const REPO = path.resolve(DASHBOARD, '..');
dotenv.config({ path: path.join(DASHBOARD, '.env') });
dotenv.config({ path: path.join(REPO, '.env') });

// Write the answer and leave. The MARKER prefix is not decoration: this process
// shares stdout with whatever else writes there (dotenv prints an "injected env"
// banner on every load), so the reader must be able to tell an answer from noise
// instead of assuming line one is ours.
const MARKER = 'BROWSER_PROBE';
function say(tag, ...fields) {
  const line = [MARKER, tag, ...fields].join('\t');
  process.stdout.write(`${line}\n`, () => process.exit(0));
  setTimeout(() => process.exit(0), 1500);
}
const firstLine = (e) => String(e?.message || e || '').split('\n').find((l) => l.trim()) || 'unknown error';

async function main() {
  // Mirror the engine's own choice exactly, including its Windows convenience:
  // an explicit CHROME_PATH wins, else installed Chrome when that file exists,
  // else Playwright's bundled Chromium. Skipping the middle step would report a
  // laptop as incapable while the engine is perfectly happy using Chrome.
  let custom = String(process.env.CHROME_PATH || '').trim();
  const WINDOWS_CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
  if (!custom && fs.existsSync(WINDOWS_CHROME)) custom = WINDOWS_CHROME;

  let chromium;
  try {
    ({ chromium } = await import('playwright'));
  } catch (err) {
    return say('NOLOAD', firstLine(err));
  }
  if (!chromium) return say('NOLOAD', 'playwright exported no chromium');

  let exec = custom || null;
  if (!exec) {
    try { exec = chromium.executablePath(); } catch (err) { return say('NOEXEC', firstLine(err)); }
  }
  if (!exec) return say('NOEXEC', 'playwright returned an empty browser path');
  if (!fs.existsSync(exec)) return say('MISSING', exec);

  let browser = null;
  try {
    browser = await chromium.launch({
      headless: true,
      executablePath: custom || undefined,
      args: ['--no-sandbox', '--disable-setuid-sandbox']
    });
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 } });
    const page = await context.newPage();
    await page.goto('about:blank');
    const version = String(browser.version() || '');
    await context.close();
    return say('OK', exec, version);
  } catch (err) {
    return say('LAUNCHFAIL', firstLine(err));
  } finally {
    try { await browser?.close(); } catch { /* already gone */ }
  }
}

await main();
