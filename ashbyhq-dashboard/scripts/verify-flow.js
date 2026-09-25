#!/usr/bin/env node
/* =====================================================================
   END-TO-END FLOW VERIFIER — no browser, no apply run.

     node scripts/verify-flow.js [--crm]

   Proves the contract the platform is built on, against the REAL database
   the dashboard is configured for (hosted Supabase or local SQLite):

     1. the durable pre-scan queue (link_scan_jobs) behaves like a worker
        queue: enqueue -> dedupe -> single-winner claim -> backoff ->
        FAILED -> retry -> DONE, and the CA pane can read its state;
     2. an applicant is addressable by AWL-ID alone (profile present /
        needs a fetch);
     3. the post-SUCCESS privacy erase removes the form data and keeps
        exactly status + reason + the two screenshot URLs, and only clears
        the shared profile when nothing else is open for that AWL-ID;
     4. every stage of the pipeline is visible to the DEV through the
        activity feed, including the ?type=<prefix> filter.

   Everything it creates is synthetic (AWL-VERIFY-1) and deleted again in
   the `finally` block, so running it against the live cache is safe.
   --crm additionally calls the real connector for that fake AWL-ID and
   expects "seen 0" (proves the fetch path works without a browser).
   ===================================================================== */
import { migrate, db, nowIso, BACKEND } from '../db/index.js';
import {
  enqueueScanJobs, claimNextScanJob, finishScanJob, markScanJobDuration,
  requeueFailedScanJobs, scanJobCounts, getScanJobByUrl, listEvents,
  purgeApplicantFormData, applicantNeedsProfile, logEvent, upsertFieldAnswer,
  listFieldAnswers, hasBlockingMissingFacts, saveJobLinkFields, applyCaEdits
} from '../db/store.js';
import { scanStateForUrl } from '../worker/link-scanner.js';
import { buildReviewQuestions, questionIsOptional } from '../draft-service.js';
import { fieldKeyOf } from '../../field-applier.js';
import { __internals } from '../../genai-resume-filler.js';

const AWL = 'AWL-VERIFY-1';
const URL_A = 'https://jobs.ashbyhq.com/verify/11111111-1111-4111-8111-111111111111';
const URL_B = 'https://jobs.ashbyhq.com/verify/22222222-2222-4222-8222-222222222222';

let passed = 0;
let failed = 0;
function check(name, ok, detail = '') {
  if (ok) { passed += 1; console.log(`  PASS  ${name}${detail ? `  (${detail})` : ''}`); }
  else { failed += 1; console.log(`  FAIL  ${name}${detail ? `  -> ${detail}` : ''}`); }
  return ok;
}
const step = (t) => console.log(`\n${t}`);

/* ------------------------------ fixture ----------------------------- */

async function makeLink(url) {
  const slug = url.split('/').pop();
  // Param order must follow the column list: url, then url_hash.
  await db.prepare(`INSERT INTO job_links (company, title, url, url_hash, link_status, seeded_at)
    VALUES ('Verify Co', 'Role', ?, ?, 'valid', ?) ON CONFLICT (url) DO NOTHING`).run(url, `verify-${slug}`, nowIso());
  const found = await db.prepare('SELECT id FROM job_links WHERE url = ?').get(url);
  if (!found?.id) throw new Error(`job_links row for ${url} did not materialise`);
  return Number(found.id);
}

async function makeApplicant(profileJson) {
  await db.prepare(`INSERT INTO applicants (awl_id, full_name, email, profile_json)
    VALUES (?, 'Verify Synthetic', 'verify@invalid.local', ?)
    ON CONFLICT (awl_id) DO UPDATE SET profile_json = EXCLUDED.profile_json`).run(AWL, profileJson);
}

async function makeApplication(linkId, status = 'ASSIGNED') {
  await db.prepare(`INSERT INTO applications (awl_id, link_id, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?) ON CONFLICT (awl_id, link_id) DO UPDATE SET status = EXCLUDED.status, updated_at = EXCLUDED.updated_at`)
    .run(AWL, linkId, status, nowIso(), nowIso());
  const found = await db.prepare('SELECT id FROM applications WHERE awl_id = ? AND link_id = ?').get(AWL, linkId);
  if (!found?.id) throw new Error(`applications row for link ${linkId} did not materialise`);
  return Number(found.id);
}

// The queue is global, so on a shared database a claim could hand us somebody
// else's real link. Anything that is not our synthetic URL is put back exactly
// as it was and we look at the next due row.
let returnedForeign = 0;
async function claimMine(claimer) {
  for (let i = 0; i < 25; i += 1) {
    const job = await claimNextScanJob({ claimer });
    if (!job) return null;
    if (job.url === URL_A || job.url === URL_B) return job;
    await db.prepare(`UPDATE link_scan_jobs SET status = 'PENDING', claimed_by = NULL, claimed_at = NULL,
      started_at = NULL, attempts = attempts - 1, updated_at = ? WHERE id = ?`).run(nowIso(), job.id);
    returnedForeign += 1;
  }
  return null;
}

async function cleanup() {
  // applications / answers / job_link_fields cascade off applicants + job_links.
  await db.prepare('DELETE FROM application_events WHERE application_id IN (SELECT id FROM applications WHERE awl_id = ?)').run(AWL);
  await db.prepare('DELETE FROM applications WHERE awl_id = ?').run(AWL);
  await db.prepare('DELETE FROM applicant_field_answers WHERE awl_id = ?').run(AWL);
  await db.prepare('DELETE FROM applicants WHERE awl_id = ?').run(AWL);
  await db.prepare('DELETE FROM job_links WHERE url IN (?, ?)').run(URL_A, URL_B);
  await db.prepare('DELETE FROM job_links WHERE url_hash IN (?, ?)').run(URL_A, URL_B);
  await db.prepare('DELETE FROM link_scan_jobs WHERE url IN (?, ?)').run(URL_A, URL_B);
}

/* ------------------------------ checks ------------------------------ */

async function verifySchema() {
  step('1. schema (migrate created the new structures)');
  try {
    await db.prepare('SELECT id, status, attempts, next_attempt_at FROM link_scan_jobs LIMIT 0').all();
    check('link_scan_jobs exists', true);
  } catch (err) { check('link_scan_jobs exists', false, err.message); }
  try {
    await db.prepare('SELECT purged_at FROM applications LIMIT 0').all();
    check('applications.purged_at exists', true);
  } catch (err) { check('applications.purged_at exists', false, err.message); }
  try {
    await db.prepare('SELECT screenshots_json, fail_reason, screenshot_path FROM applications LIMIT 0').all();
    check('status + reason + screenshot columns exist', true);
  } catch (err) { check('status + reason + screenshot columns exist', false, err.message); }
}

async function verifyScanQueue() {
  step('2. pre-scan worker queue (durable, claim-based, retrying)');
  const q1 = await enqueueScanJobs([URL_A], { reason: 'verify' });
  check('intent is queued as a row', q1.queued.length === 1, JSON.stringify(q1));
  const q2 = await enqueueScanJobs([URL_A], { reason: 'verify' });
  check('a second intent for the same link dedupes', q2.queued.length === 0 && q2.skipped[0]?.why === 'already_queued', JSON.stringify(q2.skipped));

  const job = await claimMine('verify-process');
  check('a claim wins the row and stamps RUNNING', job?.url === URL_A && job.status === 'RUNNING' && job.attempts === 1, `attempt ${job?.attempts}`);
  check('no second worker can take the same row', (await claimMine('verify-other'))?.id !== job?.id);
  check('CA pane reports the live scan', (await scanStateForUrl(URL_A)) === 'pre_scanning');

  const retry = await finishScanJob(job.id, { ok: false, error: 'verify: simulated failure', maxAttempts: 3, attempts: 1 });
  const row1 = await getScanJobByUrl(URL_A);
  check('a failure backs off instead of giving up', retry === 'RETRY' && row1.status === 'PENDING' && Date.parse(row1.next_attempt_at) > Date.now(),
    `next attempt at ${String(row1.next_attempt_at).slice(11, 19)}`);
  check('the reason is kept for the DEV', /simulated failure/.test(row1.last_error || ''), row1.last_error);
  check('CA pane says "queued" while it waits', (await scanStateForUrl(URL_A)) === 'queued');
  check('a due-time row is not claimable yet', (await claimMine('verify-early'))?.id !== row1.id);

  await db.prepare('UPDATE link_scan_jobs SET next_attempt_at = NULL, status = ? WHERE url = ?').run('PENDING', URL_A);
  await claimMine('verify-process');                                           // attempt 2
  await finishScanJob(row1.id, { ok: false, error: 'verify: again', maxAttempts: 3, attempts: 2 });
  await db.prepare('UPDATE link_scan_jobs SET next_attempt_at = NULL WHERE url = ?').run(URL_A);
  await claimMine('verify-process');                                           // attempt 3
  const parked = await finishScanJob(row1.id, { ok: false, error: 'verify: exhausted', maxAttempts: 3, attempts: 3 });
  check('after max_attempts the link parks as FAILED', parked === 'FAILED' && (await getScanJobByUrl(URL_A)).status === 'FAILED', `attempts ${(await getScanJobByUrl(URL_A)).attempts}`);
  check('CA pane says the scan failed', (await scanStateForUrl(URL_A)) === 'failed');

  const requeued = await requeueFailedScanJobs();
  check('the DEV retry button re-arms failed links', requeued >= 1 && (await getScanJobByUrl(URL_A)).status === 'PENDING', `requeued ${requeued}`);

  await db.prepare('UPDATE link_scan_jobs SET next_attempt_at = NULL WHERE url = ?').run(URL_A);
  const last = await claimMine('verify-process');
  await finishScanJob(last.id, { ok: true, fields: 9, maxAttempts: 3, attempts: last.attempts });
  await markScanJobDuration(last.id, 4321);
  const done = await getScanJobByUrl(URL_A);
  const counts = await scanJobCounts();
  check('a successful scan lands as DONE with its field count', done.status === 'DONE' && done.fields === 9 && done.duration_ms === 4321,
    `counts ${JSON.stringify(counts)}`);
  check('a DONE link is not re-scanned by default', (await enqueueScanJobs([URL_A])).skipped[0]?.why === 'already_scanned');
  check('...unless an explicit re-scan is asked for', (await enqueueScanJobs([URL_A], { force: true })).queued.length === 1);
  check('an unknown link has no scan state at all', (await scanStateForUrl(URL_B)) === null);
  await db.prepare('DELETE FROM link_scan_jobs WHERE url = ?').run(URL_A);
}

async function verifyApplicantAndPurge() {
  step('3. AWL-ID -> profile, and the post-success erase');
  await makeApplicant('{}');
  check('an empty snapshot is flagged as needing a CRM fetch', await applicantNeedsProfile(AWL));
  await makeApplicant(JSON.stringify({ personal: { name: 'Verify Synthetic' }, raw: { client: { applywizz_id: AWL } } }));
  check('a stored snapshot means no fetch is needed', !(await applicantNeedsProfile(AWL)));

  const linkA = await makeLink(URL_A);
  const linkB = await makeLink(URL_B);
  const appA = await makeApplication(linkA);
  const appB = await makeApplication(linkB);

  // The FORM inventory (what a scan writes) is what the review pane and the
  // APPLY gate read, so the fixture has to carry one: a required text box, a
  // radio whose options the CA must be able to pick from, and a question the
  // draft never answered at all (the disappearing-question regression).
  const qName = 'Full Name';
  const qGender = 'Gender';
  const qLinkedin = '[Optional] LinkedIn profile URL';
  await saveJobLinkFields(linkA, [
    { question: qName, kind: 'text', required: true },
    { question: qGender, kind: 'radio', options: ['Female', 'Male', 'Prefer not to say'], required: true },
    { question: qLinkedin, kind: 'text', required: null }
  ]);
  await upsertFieldAnswer({ awlId: AWL, linkId: linkA, fieldKey: fieldKeyOf(qName), questionText: qName, fieldType: 'text', value: 'Verify Synthetic', source: 'deterministic', sortOrder: 0 });
  await upsertFieldAnswer({ awlId: AWL, linkId: linkA, fieldKey: fieldKeyOf(qLinkedin), questionText: qLinkedin, fieldType: 'text', value: null, source: 'missing_fact', optional: 1, sortOrder: 2 });
  // An answer whose question is no longer on the form (a re-scan reworded it).
  await upsertFieldAnswer({ awlId: AWL, linkId: linkA, fieldKey: 'verify_sponsorship', questionText: 'Do you now or will you in the future require sponsorship?', fieldType: 'radio', options: ['Yes', 'No'], value: 'No', source: 'deterministic', sortOrder: 3 });

  const questions = await buildReviewQuestions(AWL, linkA);
  check('the pane shows every question the FORM asks, not just the answered ones',
    questions.filter((r) => !r.stale).length === 3, `${questions.length} row(s) for 3 question(s)`);
  const gender = questions.find((r) => r.field_key === fieldKeyOf(qGender));
  check('an unanswered question still reaches the CA with its type + options',
    gender?.field_type === 'radio' && gender.options.length === 3 && gender.source === 'needs_input' && gender.value === null,
    `${gender?.field_type}/${gender?.source}`);
  check('the form\'s required marker decides what blocks APPLY', gender?.required === 1 && questions.find((r) => r.field_key === fieldKeyOf(qName))?.required === 1);
  check('a "[Optional]" prefix never blocks, and a NULL marker does',
    questionIsOptional({ required: null, question_text: qLinkedin }) && !questionIsOptional({ required: null, question_text: qGender }));
  check('an answer whose question left the form is flagged stale, not dropped',
    questions.some((r) => r.stale && r.field_key === 'verify_sponsorship' && r.value === 'No'));
  check('a required question nobody answered blocks APPLY', await hasBlockingMissingFacts(AWL, linkA));
  // The CA typing into a box the draft never wrote must create the row, or the
  // gate would lock with no way out.
  const created = await applyCaEdits(AWL, linkA, { [fieldKeyOf(qGender)]: 'Female' });
  check('a CA answer to a question with no row is stored', created === 1 && !(await hasBlockingMissingFacts(AWL, linkA)),
    'APPLY unlocked once the pane was completed');
  const answered = await listFieldAnswers(AWL, linkA);
  check('questions are answered from the applicant row alone', answered.length === 4 && Boolean(answered.find((r) => r.value)), `${answered.length} row(s)`);

  // The run succeeded: evidence + reason are persisted, then the data goes.
  await db.prepare(`UPDATE applications SET status = 'SUCCESS', screenshot_path = ?, screenshots_json = ?, fail_reason = NULL WHERE id = ?`)
    .run('https://cdn.example/public/ack.png', JSON.stringify({ pre_submit: 'https://cdn.example/public/pre.png', acknowledgement: 'https://cdn.example/public/ack.png' }), appA);
  const purge = await purgeApplicantFormData(AWL, linkA, appA);
  check('the (applicant, link) answers are erased', purge.answersRemoved === 4 && (await listFieldAnswers(AWL, linkA)).length === 0, `${purge.answersRemoved} row(s)`);
  check('the shared profile survives while another link is open', !purge.profileCleared && !(await applicantNeedsProfile(AWL)));
  const kept = await db.prepare('SELECT status, fail_reason, screenshot_path, screenshots_json, purged_at FROM applications WHERE id = ?').get(appA);
  check('status + screenshot URLs + purged_at survive the erase',
    kept.status === 'SUCCESS' && Boolean(kept.screenshot_path) && String(kept.screenshots_json).includes('pre_submit') && Boolean(kept.purged_at));

  await db.prepare("UPDATE applications SET status = 'FAILED', fail_reason = 'verify: validation banner text' WHERE id = ?").run(appB);
  const purge2 = await purgeApplicantFormData(AWL, linkB, appB);
  check('with nothing open the profile itself is cleared', purge2.profileCleared && (await applicantNeedsProfile(AWL)));
  const keptB = await db.prepare('SELECT status, fail_reason FROM applications WHERE id = ?').get(appB);
  check('a failed run keeps its reason for the CA and DEV', keptB.status === 'FAILED' && /validation banner/.test(keptB.fail_reason || ''));
  return { appA };
}

/* --------------------- location shapes + record map ------------------ */

// The CRM stores every applicant's location in three separate columns and the
// form asks for exactly one shape. Filling a ZIP box with "Raleigh, North
// Carolina" is a wrong answer no submit gate ever catches, so the rule reads the
// SHAPE off the question and abstains when that shape is not on record.
const { buildRecordMap, resolveDerived } = __internals;
const box = (question, kind = 'text') => ({
  kind, type: kind, questionText: question, label: '', name: '', id: '',
  placeholder: '', ariaLabel: '', options: []
});
const THREE_FORMS = {
  state_of_residence: 'Raleigh, North Carolina',
  zip_or_country: '27601',
  full_address: '100 Warm Springs Ct, Raleigh, NC 27601'
};
function shapeCheck(label, rawClient, question, expected) {
  const map = buildRecordMap({ raw: { client: rawClient, additional_information: {} } });
  const got = resolveDerived(box(question), map, {}) || '';
  check(label, got === expected, `got ${JSON.stringify(String(got).slice(0, 40))}`);
}

async function verifyLocationShapes() {
  step('3b. one location question, three record shapes');
  shapeCheck('a bare "Location" box takes the residence shape', THREE_FORMS,
    'Which of the following locations best describes yours?', THREE_FORMS.state_of_residence);
  shapeCheck('a ZIP box takes the ZIP, never the residence', THREE_FORMS,
    'What is your ZIP code?', THREE_FORMS.zip_or_country);
  shapeCheck('a full-address box takes the street address', THREE_FORMS,
    'Please enter your full address.', THREE_FORMS.full_address);
  shapeCheck('a postal-code box is not fooled by the word "address"', THREE_FORMS,
    'Mailing address postal code', THREE_FORMS.zip_or_country);
  shapeCheck('a country question never receives the ZIP', THREE_FORMS,
    'Which country are you currently based in?', '');
  shapeCheck('a missing shape abstains instead of guessing', { state_of_residence: 'Raleigh, North Carolina' },
    'What is your ZIP code?', '');
  shapeCheck('a country name answers a country question', { zip_or_country: 'United States' },
    'Which country are you in?', 'United States');
  shapeCheck('an email box is not a postal address', THREE_FORMS, 'What is your email address?', '');
}

async function verifyDevLog(appA) {
  step('4. DEV activity feed');
  const types = ['applicant_profile_fetched', 'link_scan_start', 'link_scan_done', 'draft_pass', 'ca_answers_edited', 'screenshots_uploaded', 'applicant_data_purged', 'run_success'];
  for (const t of types) await logEvent(appA, t, 'verify', { probe: t });
  // One probe per type: the prefix filter is what the DEV dropdown uses, so it
  // must find the event AND must not leak unrelated stages into the result.
  let missing = [];
  for (const t of types) {
    const rows = await listEvents({ limit: 20, type: t });
    if (!rows.some((r) => r.type === t)) missing.push(t);
  }
  check('every stage of the pipeline emits an event', missing.length === 0, missing.length ? `missing ${missing.join(', ')}` : `${types.length} types`);
  const shots = await listEvents({ limit: 50, type: 'screenshots' });
  check('the feed filters by stage (type=screenshots)', shots.length >= 1 && shots.every((e) => e.type.startsWith('screenshots')), `${shots.length} row(s)`);
  const scan = await listEvents({ limit: 50, type: 'link_scan' });
  check('one prefix covers a whole worker (type=link_scan)', scan.length >= 2 && scan.every((e) => e.type.startsWith('link_scan')), `${scan.length} row(s)`);
  const ctx = await listEvents({ limit: 10, type: 'ca_answers_edited' });
  check('the feed carries the AWL-ID + link context', ctx.some((e) => e.awl_id === AWL && e.company === 'Verify Co'));
}

/* --------------------- .csv / paste ingestion parser -----------------
   Pure parser assertions (no writes): the DEV tab hands a whole uploaded file
   to the same function a pasted block goes through, so these shapes are the
   ingest contract. A row that is guessed wrong applies a real person to the
   wrong job, hence the "must be skipped, not inferred" checks. */
async function verifyCsvParser() {
  step('5. Job-link table parser (.csv upload + paste)');
  const { parseAwlLinkTable } = await import('../core/joblink-csv.js');
  const U1 = 'https://jobs.ashbyhq.com/acme/3f2b1c9a-0000-4000-8000-000000000001';
  const U2 = 'https://jobs.ashbyhq.com/acme/3f2b1c9a-0000-4000-8000-000000000002';

  const headed = parseAwlLinkTable(
    `applywizz_id,job_link,company,title\nAWL-101,${U1},Acme,Staff Engineer\n102,${U2}?src=Linkedin,Acme,"Data, Infra"\n`);
  check('a header row is consumed, not ingested', headed.pairs.length === 2 && headed.header, `${headed.pairs.length} pair(s)`);
  check('a bare numeric id is keyed exactly as the CRM keys it', headed.pairs[1]?.awlId === '102', headed.pairs[1]?.awlId);
  check('tracking params collapse to one link', headed.pairs[1]?.url === U2, headed.pairs[1]?.url);
  check('company + title columns are carried', headed.pairs[1]?.title === 'Data, Infra', headed.pairs[1]?.title);

  const priority = parseAwlLinkTable(`id,applywizz_id,url\n999,AWL-201,${U1}\n`);
  check('the specific id column beats a generic "id"', priority.pairs[0]?.awlId === 'AWL-201', priority.pairs[0]?.awlId);

  const quoted = parseAwlLinkTable(`awl,job link\nAWL-202,"${U1}"\nAWL-203,"${U2}","note with ""quotes"""\n`);
  check('quoted cells (and "" escapes) parse', quoted.pairs.length === 2 && quoted.pairs[0].url === U1, `${quoted.pairs.length} pair(s)`);

  const tsv = parseAwlLinkTable(`awl_id\tjob_link\nAWL-204\t${U1}\n`);
  check('a TSV export parses', tsv.pairs[0]?.awlId === 'AWL-204' && tsv.pairs[0]?.url === U1, `${tsv.pairs.length} pair(s)`);

  const commented = parseAwlLinkTable(`# exported from the CRM\nawl_id,job_link\nAWL-205,${U1}\n`);
  check('a leading comment does not hide the header', commented.header && commented.pairs.length === 1 && !commented.skipped.length,
    `${commented.pairs.length} pair(s), ${commented.skipped.length} skipped`);

  const pasted = parseAwlLinkTable(
    `# pasted from the CRM\nAWL-101   ${U1}\nawl102 | ${U2}\n\nAWL-101   ${U1}?source=linkedin\n`);
  check('header-less pasted lines match by shape', pasted.pairs.length === 2, `${pasted.pairs.length} pair(s)`);
  check('comments are ignored and repeats deduped', !pasted.skipped.length && pasted.pairs.every((p) => p.awlId !== 'IGNORED'));

  const bad = parseAwlLinkTable(`awl_id,job_link\nAWL-301,not-a-url\nsee notes,${U1}\n,,\n`);
  check('a row without a real link is skipped', bad.skipped.some((s) => s.reason === 'no http(s) job link'), JSON.stringify(bad.skipped));
  check('prose in the id column is skipped, not guessed', bad.skipped.some((s) => /not an id/.test(s.reason)), JSON.stringify(bad.skipped));
  check('an empty row is dropped silently', bad.pairs.length === 0 && !bad.skipped.some((s) => s.line === 4));
}

async function verifyCrmFetch() {
  step('6. CRM fetch (--crm only; needs the Azure connection)');
  const { isConfigured, syncApplicantByAwl } = await import('../connector/applicant-db.js');
  if (!isConfigured()) { console.log('  SKIP  PG_* not configured'); return; }
  const summary = await syncApplicantByAwl(AWL);
  check('a lookup by AWL-ID alone completes', summary?.seen === 0, `seen ${summary?.seen} (0 = the synthetic id is correctly absent)`);
}

/* -------------------------------- run ------------------------------- */

console.log(`Flow verifier — backend: ${BACKEND}`);
await migrate();
try {
  await verifySchema();
  await verifyScanQueue();
  const { appA } = await verifyApplicantAndPurge();
  await verifyLocationShapes();
  await verifyDevLog(appA);
  await verifyCsvParser();
  if (process.argv.includes('--crm')) await verifyCrmFetch();
} catch (err) {
  failed += 1;
  console.error('\n  EXCEPTION', err);
} finally {
  if (returnedForeign) console.log(`  (note: ${returnedForeign} unrelated link_scan_jobs claim(s) were touched and handed back)`);
  await cleanup().catch((e) => console.error('cleanup:', e.message));
  const left = await db.prepare('SELECT COUNT(1) AS n FROM applicants WHERE awl_id = ?').get(AWL);
  check('synthetic fixture removed again', !Number(left?.n || 0));
}
console.log(`\n${failed ? 'FAILED' : 'PASSED'} — ${passed} passed, ${failed} failed.`);
process.exit(failed ? 1 : 0);
