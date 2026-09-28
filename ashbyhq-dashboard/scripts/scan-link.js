#!/usr/bin/env node
/* Pre-scan ONE job link and cache its question inventory.

   node scripts/scan-link.js "<job-url>" [--force]

   A link never changes, but the number of applicants attached to it does, so the
   scan happens ONCE per link:

     1. already scanned locally ....... reuse job_link_fields (unless --force)
     2. scanned by any other install .. restore from the shared
                                        public.ashby_joblink_questions cache
                                        (no browser is launched)
     3. never scanned ................. open Chrome in SCAN_ONLY, store the
                                        inventory locally AND push it to the
                                        shared cache keyed by job_id + job_link

   Tiers 1 and 2 need no browser, so a machine that cannot launch one can still
   answer a link. Setting SCAN_NO_BROWSER=true (the scan worker does, from its own
   browser capability probe) stops the script BEFORE tier 3: it prints NEEDS_BROWSER
   and exits 3, which the worker reads as "defer this row for a host that has a
   browser" rather than "this link is broken".

   Before this script, links were only registered by an applicant sync; the
   dashboard now also accepts pasted (AWL-ID -> link) pairs (POST /api/dev/links),
   which is what puts the link into job_links + the shared cache.
*/
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { spawn } from 'child_process';
import dotenv from 'dotenv';
import { migrate, db, nowIso } from '../db/index.js';
import { saveJobLinkFields, listJobLinkFields } from '../db/store.js';
import { upsertJobLinkQuestions, fetchJobLinkQuestions, jobIdFromUrl, normalizeJobLink } from '../connector/joblink-questions.js';
import { companyFromUrl } from '../core/job-url.js';
import { judgeScan, inventoryIsResidue } from '../core/scan-verdict.js';
import { summarizeField } from '../../genai-resume-filler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const ENGINE = path.join(REPO, 'ashby-hybrid-automation.js');
dotenv.config({ path: path.join(REPO, '.env') });

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
// Cache-only mode, decided by the caller's browser probe (never by a guess).
const NO_BROWSER = String(process.env.SCAN_NO_BROWSER || '').toLowerCase() === 'true';
const url = argv.find((a) => !a.startsWith('--'));
if (!url) {
  console.error('usage: node scripts/scan-link.js "<job-url>"   (no built-in default link)');
  process.exit(1);
}

await migrate();

const link = normalizeJobLink(url);
const jobId = jobIdFromUrl(link);

// Find or materialise the job_links row. RETURNING id works on both backends,
// so no lastInsertRowid (which is null on Postgres) is relied upon.
let row = await db.prepare('SELECT id FROM job_links WHERE url = ?').get(link)
  || await db.prepare('SELECT id FROM job_links WHERE url = ?').get(url);
if (!row) {
  row = await db.prepare(`INSERT INTO job_links (company, title, url, url_hash, link_status, seeded_at)
    VALUES (?, ?, ?, ?, ?, ?) RETURNING id`)
    .get(companyFromUrl(link) || 'Unknown', 'Role', link, link.replace(/[^a-z0-9]+/gi, '-').toLowerCase(), 'valid', nowIso());
  console.log(`Created job_links row id ${row?.id} for ${link}`);
}
const linkId = Number(row?.id);
if (!linkId) { console.error('Could not resolve a job_links id for this URL.'); process.exit(1); }

// The shared cache stores the scan SHAPE ({ question, kind, options }); the local
// table stores the row shape. Used only to re-publish what this install already
// knows, never to re-save anything locally.
const toSharedShape = (rows) => rows.map((r) => {
  let options = [];
  try { options = JSON.parse(r.options_json || '[]'); } catch { options = []; }
  return {
    field_key: r.field_key,
    question: r.question_text,
    kind: r.field_type,
    options: Array.isArray(options) ? options : [],
    required: r.required === 1 ? true : (r.required === 0 ? false : null),
    ...(r.question_summary ? { question_summary: r.question_summary } : {})
  };
});

// 1. local inventory already exists
// An inventory of a single field on a non-/application URL is not "already
// scanned", it is the residue of a listing page (core/scan-verdict.js). Falling
// through lets a browser-capable host re-scan and clear it instead of every
// later applicant being served that junk from the cache.
if (!FORCE) {
  const local = await listJobLinkFields(linkId);
  if (local.length && !inventoryIsResidue(local, link)) {
    console.log(`\nAlready scanned: ${local.length} field(s) cached locally for job_links.id=${linkId} (job_id ${jobId}).`);
    // Self-heal the SHARED cache. A link can hold a complete local inventory
    // while the shared row is still the empty '[]' created at ingest — a publish
    // that died on a CRM trigger, an install that scanned before the cache
    // existed, a host that lost the write. Left alone, every other machine keeps
    // re-scanning (or, with no browser, deferring) a link that is already known,
    // and short-circuiting here is exactly what hides it. One read, and one write
    // only when the shared copy is BEHIND (never downgrade a richer row).
    try {
      const shared = await fetchJobLinkQuestions(link);
      const have = shared?.questions?.length || 0;
      if (have < local.length) {
        const pushed = await upsertJobLinkQuestions({ url: link, questions: toSharedShape(local) });
        console.log(pushed.ok
          ? `Shared cache refreshed from this install's inventory (${have} -> ${pushed.count ?? local.length} question(s)).`
          : `Shared cache still stale (${pushed.error || pushed.skipped}); the local inventory still answers this install.`);
      }
    } catch (err) {
      console.log(`(shared-cache check skipped: ${String(err.message || err).slice(0, 80)})`);
    }
    console.log('Use --force to re-scan with a browser.');
    process.exit(0);
  }
  if (local.length) console.log('Local inventory is a single field on a non-form URL — treating it as unscanned and re-checking.');
  // 2. shared cache hit -> restore, no browser
  const cached = await fetchJobLinkQuestions(link);
  if (cached?.questions?.length && !inventoryIsResidue(cached.questions, link)) {
    const n = await saveJobLinkFields(linkId, cached.questions);
    console.log(`\nRestored ${n} field(s) from public.ashby_joblink_questions (job_id ${cached.job_id}) — no browser needed.`);
    cached.questions.forEach((f, i) => console.log(`  ${i + 1}. [${f.kind || 'text'}] ${String(f.question || f.field_key || '').slice(0, 110)}`));
    process.exit(0);
  }
}

/* Pick a human-readable posting title out of what the scan page exposed.
   Ordered by trust: an explicit job-title element/attribute, then <h1>, then the
   document title minus its "… | Ashby" tail. Generic headings ("Apply for this
   job") and page-title-only noise are rejected so we never store a wrong role. */
function postingTitle(posting = {}) {
  const p = posting || {};
  const clean = (s) => String(s || '').replace(/\s+/g, ' ').trim();
  const generic = /^(apply(ing)? for this job|application|job application|career ?(portal|page)?|loading|ashby( ?jobs?)?)$/i;
  const direct = clean(p.jobTitle) || clean(p.headingAttr) || clean(p.h1);
  if (direct && !generic.test(direct) && direct.length <= 120) return direct;
  const doc = clean(p.docTitle);
  if (doc) {
    const head = doc.split(/\s+[|\u2013\u2014]\s+|\s+-\s+Ashby/i)[0].trim();
    if (head && head.length <= 120 && !generic.test(head) && head.toLowerCase() !== 'ashby') return head;
  }
  return '';
}

/* A near-empty "form" is never a form — the rule and its history live in
   core/scan-verdict.js, which is asserted by scripts/verify-flow.js. Nothing is
   stored or published until the scan passes it. */

// 3. scan live
if (NO_BROWSER) {
  // Reached only when both inventory tiers missed, so the link genuinely needs a
  // page load. Say so in one machine-readable line and leave the row for a host
  // that can open a window.
  console.log(`NEEDS_BROWSER: no cached inventory for ${link} and this host has no usable browser`);
  process.exit(3);
}
const out = path.join(os.tmpdir(), `field-scan-${Date.now()}.json`);
// The worker drives this path with SCAN_HEADLESS=true (default) so background
// scanning never steals the operator's screen; 'false' opens a visible window.
console.log(process.env.SCAN_HEADLESS === 'false'
  ? 'Launching engine in SCAN_ONLY mode (a Chrome window will open)…'
  : 'Launching engine in SCAN_ONLY mode (headless — set SCAN_HEADLESS=false to watch it)…');

const child = spawn(process.execPath, [ENGINE, link], {
  cwd: REPO,
  env: { ...process.env, SCAN_ONLY: 'true', FIELD_SCAN_OUT: out, JOB_URL: link },
  stdio: 'inherit'
});

child.on('exit', async (code) => {
  if (!fs.existsSync(out)) {
    console.error(`No scan output produced (engine exit code ${code}).`);
    process.exit(1);
  }
  const scan = JSON.parse(fs.readFileSync(out, 'utf8'));
  const fields = scan.fields || [];

  // Nothing is written — locally or to the shared cache — until the scan is
  // provably an application form.
  const verdict = judgeScan(scan, link);
  if (!verdict.ok) {
    try { fs.unlinkSync(out); } catch { /* temp file only */ }
    // Clear a previously stored one-field inventory so the review pane cannot
    // keep showing junk after this link has been correctly refused. A real
    // inventory (2+ fields) is never touched here.
    try {
      const prior = await listJobLinkFields(linkId);
      if (inventoryIsResidue(prior, link)) {
        await db.prepare('DELETE FROM job_link_fields WHERE link_id = ?').run(linkId);
        console.log('Cleared the stale single-field inventory that was cached for this link.');
      }
    } catch { /* best effort */ }
    console.error(`Scan refused: ${verdict.why}`);
    console.error('Nothing was stored or published. If this URL is a job listing, replace it with the real application link (jobs.ashbyhq.com/<company>/<posting-id>/application).');
    process.exit(4);
  }

  // The scan saw the real posting page, so it also names the job. Replace the
  // "Role" placeholder (and nothing else — a title that came from the CRM wins).
  const title = postingTitle(scan.posting);
  if (title) {
    const r = await db.prepare("UPDATE job_links SET title = ? WHERE id = ? AND (title IS NULL OR title = '' OR title = 'Role')").run(title, linkId);
    if (r.changes) console.log(`Posting title resolved: "${title}"`);
  }

  // Distill overly long questions / option lists to a one-line GenAI gist so the
  // CA sees "the exact plot" at a glance (the full text is still stored). Only
  // genuinely verbose fields are summarized, to conserve the daily quota.
  const isLong = (f) => {
    const q = String(f.question || '');
    const opts = (f.options || []).map(String);
    return q.length > 150 || opts.some((o) => o.length > 60) || opts.reduce((a, o) => a + o.length, 0) > 160;
  };
  if (process.env.GEMINI_API_KEY) {
    for (const f of fields) {
      if (!isLong(f)) continue;
      try {
        f.question_summary = await summarizeField(f.question, f.options || []);
        console.log(`  gist [${f.kind}] -> ${f.question_summary}`);
      } catch (e) {
        console.log(`  (gist skipped for a long field: ${String(e.message).slice(0, 60)})`);
      }
    }
  }

  const n = await saveJobLinkFields(linkId, fields);
  try { fs.unlinkSync(out); } catch { /* temp file only */ }

  // Publish to the shared cache: one row per link, questions attached.
  const pushed = await upsertJobLinkQuestions({ url: link, questions: fields });
  console.log(pushed.ok
    ? `\nStored ${n} field(s) locally and in public.ashby_joblink_questions (job_id ${pushed.jobId}).`
    : `\nStored ${n} field(s) locally; shared-cache write skipped (${pushed.error || pushed.skipped}).`);
  fields.forEach((f, i) => {
    const opts = f.options && f.options.length ? `\n     options: [${f.options.join(' | ')}]` : '';
    const gist = f.question_summary ? `\n     \u21b3 ${f.question_summary}` : '';
    console.log(`  ${i + 1}. [${f.kind}] ${f.question}${opts}${gist}`);
  });
});
