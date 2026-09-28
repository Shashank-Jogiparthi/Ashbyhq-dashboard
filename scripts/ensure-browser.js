#!/usr/bin/env node
/* =====================================================================
   ENSURE A BROWSER EXISTS  (build-time, idempotent, never fatal)

   WHY this exists
   ---------------
   The automation engine drives a real Chromium, and Playwright's npm package
   does NOT ship one: the binary has to be downloaded. This repo never did that
   - `postinstall` only installed the dashboard's dependencies - so the deployed
   container had no browser at all. The queue lives in a SHARED database, so that
   container claimed real work anyway and reported its own missing binary as
   failures of other things: five job links "No scan output produced (engine exit
   code 1)" and two applicants FAILED with "Engine process exited without a
   result", when the actual line in the log was

     browserType.launch: Executable doesn't exist ... /chrome-linux64/chrome

   The runtime capability gate (ashbyhq-dashboard/core/browser-*.js) now stops any
   host from claiming what it cannot finish, so a missing browser can never again
   damage a link or an application. This file is the other half: make sure the
   browser is actually there, so a deployed host can do the work instead of just
   refusing it cleanly.

   Rules
   -----
   • idempotent - if the browser Playwright would use is already on disk, nothing
     is downloaded, and a host that points CHROME_PATH at an existing browser is
     already served and returns immediately;
   • NEVER fails the build - a failed download (or even a missing playwright
     package) must not turn a working deploy into a broken one. What it leaves
     behind is a host that the gate pins off, with the reason in the DEV pane,
     instead of a service that does not start;
   • opt-out: APPLYWIZZ_SKIP_BROWSER_INSTALL=true (or SKIP_BROWSER_INSTALL=true).
     A host that supplies its own browser via CHROME_PATH needs none of this.

   Only the Railway buildCommand runs it (and `npm run browser:install` by hand);
   `postinstall` deliberately does NOT, so an ordinary local install never pulls a
   ~150 MB browser down without being asked.
   Used from railway.json's buildCommand, and available as `npm run browser:install`.
   ===================================================================== */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

// require() inside an ESM module (the repo is "type": "module"). Resolves from
// this file's location, i.e. the repository root's node_modules - the same place
// the engine's own playwright import resolves from at runtime.
const require = createRequire(import.meta.url);

const SKIP = ['APPLYWIZZ_SKIP_BROWSER_INSTALL', 'SKIP_BROWSER_INSTALL']
  .some((k) => String(process.env[k] || '').toLowerCase() === 'true');

// Everything playwright-related is behind a try/catch: this script runs during
// `npm run build` on a host we do not control, and NOTHING here may throw.
// cli.js is not in playwright's "exports" map, so require.resolve('playwright/cli.js')
// fails even when the file is on disk - resolve the package root via the exported
// package.json instead and join from there.
function resolveCli() {
  try {
    const cli = path.join(path.dirname(require.resolve('playwright/package.json')), 'cli.js');
    return fs.existsSync(cli) ? cli : null;
  } catch {
    return null;
  }
}

function bundledChromiumPath() {
  try {
    const { chromium } = require('playwright');
    return chromium.executablePath();
  } catch {
    // playwright not installed yet (or unreadable): nothing to check, so install.
    return null;
  }
}

const run = (cli, args) => new Promise((resolve) => {
  const child = spawn(process.execPath, [cli, ...args], { stdio: 'inherit', env: process.env });
  child.on('error', (err) => { console.error(`  browser install: ${err.message}`); resolve(-1); });
  child.on('exit', (code) => resolve(code ?? 1));
});

if (SKIP) {
  console.log('browser: skipped (APPLYWIZZ_SKIP_BROWSER_INSTALL / SKIP_BROWSER_INSTALL=true).');
  process.exit(0);
}

const cli = resolveCli();
if (!cli) {
  console.warn('browser: playwright is not installed at the repo root - cannot install a browser.');
  console.warn('         This host will be pinned off by the capability gate until it is available.');
  process.exit(0);
}

const existing = bundledChromiumPath();
if (existing && fs.existsSync(existing)) {
  console.log(`browser: already present (${existing}) - nothing to install.`);
  process.exit(0);
}

// Same first step the engine and the capability probe take: an explicit
// CHROME_PATH that exists means this host is already served and downloading a
// second browser would be waste, not safety.
const declared = String(process.env.CHROME_PATH || '').trim();
if (declared && fs.existsSync(declared)) {
  console.log(`browser: CHROME_PATH points at an existing executable (${declared}) - nothing to install.`);
  process.exit(0);
}

console.log('browser: no bundled Chromium found, installing it (this is a build-time download)...');
// --with-deps installs the system libraries a headless Chromium needs. It only
// works as root in a Linux build image, so a failure there must not stop the
// browser itself from being downloaded: try the full install, then the plain one.
let code = await run(cli, ['install', '--with-deps', 'chromium']);
if (code !== 0) {
  console.log(`browser: "install --with-deps" failed (exit ${code}); retrying without system dependencies...`);
  code = await run(cli, ['install', 'chromium']);
}

const after = bundledChromiumPath();
if (code === 0 && after && fs.existsSync(after)) {
  console.log(`browser: installed at ${after}`);
  process.exit(0);
}
// Loud, but exit 0, because a missing browser must never break the deploy: the
// capability gate pins such a host off and the DEV pane says why. Breaking the
// build would take the whole platform down instead of one worker's capability.
console.warn('browser: NOT installed. This host will refuse to claim apply runs and will defer scans');
console.warn('         that need a page load, until a browser is available (npx playwright install');
console.warn('         --with-deps chromium, or point CHROME_PATH at an existing one).');
process.exit(0);
