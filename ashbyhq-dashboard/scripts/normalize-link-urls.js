#!/usr/bin/env node
/* One-time (idempotent) reconcile of stored job-link URLs.

   node scripts/normalize-link-urls.js            -> dry run, prints the plan
   node scripts/normalize-link-urls.js --apply    -> performs it

   WHY: job_links / applicant_joblinks used to be keyed on the URL exactly as it
   arrived, while the CRM tables key on the canonical posting URL. So the same
   Ashby posting could exist twice ("...?source=rLVNdemx1O" and the clean link),
   which means a later sync creates a duplicate application for an applicant who
   already has one. This script collapses those rows to the canonical form every
   writer now uses (core/job-url.js), and fills in a company name where the
   ingest path left "Unknown".

   A merge (two rows collapsing into one) repoints applications, scanned fields
   and pending links onto the surviving row — the row that already has a field
   inventory wins, otherwise the lowest id — and only then removes the duplicate.
*/
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { migrate, db } from '../db/index.js';
import { canonicalJobUrl, companyFromUrl } from '../core/job-url.js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '..', '.env') });
dotenv.config({ path: path.join(here, '..', '..', '.env') });

const APPLY = process.argv.includes('--apply');

await migrate();

const links = await db.prepare('SELECT id, company, title, url FROM job_links ORDER BY id').all();
const fieldCount = db.prepare('SELECT COUNT(1) AS n FROM job_link_fields WHERE link_id = ?');

const plan = [];
for (const l of links) {
  const canon = canonicalJobUrl(l.url);
  const company = (!l.company || l.company === 'Unknown') ? companyFromUrl(canon) : '';
  if (canon === l.url && !company) continue;
  const twin = canon !== l.url ? links.find((o) => o.id !== l.id && canonicalJobUrl(o.url) === canon) : null;
  plan.push({ id: l.id, url: l.url, canon, company, twinId: twin ? twin.id : null });
}

if (!plan.length) {
  console.log('Nothing to reconcile — every stored link is already canonical.');
  process.exit(0);
}

console.log(`${APPLY ? 'Applying' : 'DRY RUN — would apply'} ${plan.length} link fix(es):\n`);
for (const p of plan) {
  console.log(`  #${p.id}  ${p.url}`);
  console.log(`      -> ${p.canon}${p.company ? `   company: "${p.company}"` : ''}`);
  if (p.twinId) console.log(`      MERGES INTO existing #${p.twinId} (its applications/fields are repointed)`);
}

if (!APPLY) {
  console.log('\nRe-run with --apply to make it real.');
  process.exit(0);
}

let renamed = 0, merged = 0, filled = 0;
const dropped = new Set();      // two raw rows can collapse onto each other
for (const p of plan) {
  if (dropped.has(p.id)) continue;
  if (p.company) {
    await db.prepare('UPDATE job_links SET company = ? WHERE id = ?').run(p.company, p.id);
    filled += 1;
  }
  if (p.canon === p.url) continue;

  if (p.twinId) {
    // Surviving row: the twin, unless the twin never produced an inventory and
    // this row did. job_link_fields cascade with the row we drop, so the winner
    // is picked on that basis rather than by merging two inventories.
    const twinFields = Number((await fieldCount.get(p.twinId))?.n || 0);
    const myFields = Number((await fieldCount.get(p.id))?.n || 0);
    const target = (twinFields === 0 && myFields > 0) ? p.id : p.twinId;
    const drop = target === p.id ? p.twinId : p.id;
    // applications is UNIQUE(awl_id, link_id): an applicant present on both rows
    // keeps the surviving application and loses the duplicate.
    await db.prepare('DELETE FROM applications WHERE link_id = ? AND awl_id IN (SELECT awl_id FROM applications WHERE link_id = ?)').run(drop, target);
    await db.prepare('UPDATE applications SET link_id = ? WHERE link_id = ?').run(target, drop);
    await db.prepare('DELETE FROM job_links WHERE id = ?').run(drop);
    dropped.add(drop);
    merged += 1;
    console.log(`  merged #${drop} into #${target}`);
  } else {
    await db.prepare('UPDATE job_links SET url = ?, url_hash = ? WHERE id = ?')
      .run(p.canon, p.canon.replace(/[^a-z0-9]+/gi, '-').toLowerCase(), p.id);
    renamed += 1;
  }
  // Pending (not yet materialised) pairs follow the same canonical key.
  await db.prepare('UPDATE applicant_joblinks SET url = ? WHERE url = ?').run(p.canon, p.url);
}

// applicant_joblinks is UNIQUE(awl_id, url): collapse any pair the rename duplicated.
const dupes = await db.prepare(
  'SELECT awl_id, url, MIN(id) AS keep_id FROM applicant_joblinks GROUP BY awl_id, url HAVING COUNT(1) > 1'
).all();
for (const d of dupes) {
  await db.prepare('DELETE FROM applicant_joblinks WHERE awl_id = ? AND url = ? AND id <> ?').run(d.awl_id, d.url, d.keep_id);
}

const left = await db.prepare('SELECT COUNT(1) AS n FROM job_links').get();
console.log(`\nDone: ${renamed} renamed, ${merged} merged, ${filled} company name(s) filled. job_links now ${left?.n} row(s).`);
console.log('Verify with: node scripts/scan-link.js "<canonical url>"  (or the DEV → Pre-scan queue button).');
