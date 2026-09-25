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
import { summarizeField } from '../../genai-resume-filler.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
const ENGINE = path.join(REPO, 'ashby-hybrid-automation.js');
dotenv.config({ path: path.join(REPO, '.env') });

const argv = process.argv.slice(2);
const FORCE = argv.includes('--force');
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

// 1. local inventory already exists
if (!FORCE) {
  const local = await listJobLinkFields(linkId);
  if (local.length) {
    console.log(`\nAlready scanned: ${local.length} field(s) cached locally for job_links.id=${linkId} (job_id ${jobId}).`);
    console.log('Use --force to re-scan with a browser.');
    process.exit(0);
  }
  // 2. shared cache hit -> restore, no browser
  const cached = await fetchJobLinkQuestions(link);
  if (cached?.questions?.length) {
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

// 3. scan live
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
