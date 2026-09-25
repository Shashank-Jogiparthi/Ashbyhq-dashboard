/* Pre-Apply draft pass — CLI.
   Usage:
     node scripts/draft-answers.js <awl_id> <link_id>
     node scripts/draft-answers.js --app <application_id>
   Runs Tier 1/2 deterministic resolution + Tier 3 GenAI drafting for every
   scanned field of a (applicant, link) pair, persists rows into
   applicant_field_answers, then prints the classified output so the operator
   can eyeball which fields got deterministic values, which were drafted by
   GenAI, and which are still flagged 'missing_fact' (category C — CA must
   fill these before APPLY is allowed). */
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { migrate, db } from '../db/index.js';
import { runDraftPass, listConfirmedAnswers } from '../draft-service.js';
import { listFieldAnswers } from '../db/store.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, '..', '..');
dotenv.config({ path: path.join(REPO, '.env') });

migrate();

const args = process.argv.slice(2);
let awlId = null;
let linkId = null;

if (args[0] === '--app') {
  const appId = Number(args[1]);
  const row = db.prepare('SELECT awl_id, link_id FROM applications WHERE id = ?').get(appId);
  if (!row) { console.error(`No application id ${appId}`); process.exit(1); }
  awlId = row.awl_id;
  linkId = row.link_id;
} else {
  awlId = args[0];
  linkId = Number(args[1]);
}

if (!awlId || !linkId) {
  console.error('Usage: node scripts/draft-answers.js <awl_id> <link_id>   |   node scripts/draft-answers.js --app <application_id>');
  process.exit(1);
}

const link = await db.prepare('SELECT id, company, url FROM job_links WHERE id = ?').get(linkId);
if (!link) { console.error(`No job_links row ${linkId}`); process.exit(1); }

console.log(`Draft pass: ${awlId}  ×  link ${linkId} (${link.company})`);
console.log(`           ${link.url}`);
if (!process.env.GEMINI_API_KEY) console.log('(!) GEMINI_API_KEY unset — running deterministic-only; every unresolved field will fall through to placeholder/missing_fact.');
console.log('');

const outcome = await runDraftPass(awlId, linkId, { log: (m) => console.log(m) });

const rows = await listFieldAnswers(awlId, linkId);
const groups = { deterministic: [], genai: [], placeholder: [], missing_fact: [], ca_edited: [] };
for (const r of rows) (groups[r.source] || (groups[r.source] = [])).push(r);

const banner = (s) => `\n─── ${s} (${groups[s]?.length || 0}) ` + '─'.repeat(Math.max(0, 60 - s.length));

console.log(banner('deterministic') + '  [A — auto-filled from applicant record]');
for (const r of groups.deterministic || []) {
  const src = (r.evidence || []).find((e) => String(e).startsWith('record column:'));
  console.log(`  ✓ [${r.field_type}] ${r.question_text}\n      = ${r.value}${src ? `\n      from ${src.slice('record column: '.length)}` : ''}`);
}

console.log(banner('genai') + '  [B — AI-drafted, needs CA approval]');
for (const r of groups.genai || []) {
  const ev = r.evidence?.length ? `\n      evidence: ${r.evidence.slice(0, 3).join(' · ')}` : '';
  console.log(`  ✍️ [${r.field_type}] ${r.question_text}\n      = ${r.value}${ev}`);
}

console.log(banner('placeholder') + '  [A/low — N/A stand-in for non-critical text]');
for (const r of groups.placeholder || []) console.log(`  ~ [${r.field_type}] ${r.question_text}  ->  ${r.value}`);

console.log(banner('missing_fact') + '  [C — CA must provide before APPLY]');
for (const r of groups.missing_fact || []) console.log(`  ❗ [${r.field_type}] ${r.question_text}  (options: ${r.options.join(' | ') || '—'})`);

console.log(`\nTotals: ${outcome.total} fields — deterministic ${outcome.deterministic} (+${outcome.bound} from a mapped record column), genai ${outcome.genai}, placeholder ${outcome.placeholder}, missing_fact ${outcome.missing}, skipped ${outcome.skipped}.`);
console.log(`GenAI usage this pass: ${outcome.mappingCalls} question-mapping call(s)${outcome.mappingError ? ` (failed: ${outcome.mappingError.slice(0, 80)})` : ''}, ${outcome.genai} answer draft(s).`);
console.log(`Submit run will replay ${(await listConfirmedAnswers(awlId, linkId)).length} non-null value(s).`);
