/**
 * ApplyWizz staff provisioner.
 * Run: node scripts/seed.js   (idempotent — re-running never duplicates)
 *
 * The staff directory IS the CRM roster and nothing else. This:
 *   1. seeds the real 59 CAs + 2 OPS + 2 ADMIN (connector/staff-roster.js) and
 *      the CA->OM edges the CRM states (buildStaffTree);
 *   2. purges every legacy @applywizz.local fixture (the old fake admin, the
 *      priya.cam -> rakesh test pair, the throwaway dev) so a fresh checkout
 *      never re-introduces phantom colleagues — the real @applywizz.com/.ai
 *      accounts, ADMINs included, are always kept.
 *
 * It no longer seeds fake applicants / job-links / applications — real
 * applicants come from the Azure CRM sync, and their links/actions live in
 * Supabase. Sign-in is OTP-based, so any roster email can log in immediately.
 */
import { migrate, db } from '../db/index.js';
import { buildStaffTree } from '../connector/applicant-db.js';
import { purgeLocalStaff } from '../connector/staff-purge.js';

await migrate();

const tree = await buildStaffTree();
console.log(`directory: ${tree.seed.created} new / ${tree.seed.updated} existing `
  + `(ca ${tree.seed.ca}, ops ${tree.seed.ops}, admin ${tree.seed.admin}); CA->OM ${tree.link.linked ?? 0}${tree.link.skipped ? ` (${tree.link.skipped})` : ''}`);

const purged = await purgeLocalStaff({ dryRun: false, actor: 'seed' });
console.log(`purge: ${purged.deleted.length} fixture(s) deleted, ${purged.retired.length} retired, ${purged.reassignable} applicant(s) re-pointed`);
for (const d of purged.deleted) console.log(`  deleted  ${d.role.toUpperCase().padEnd(4)} ${d.email}`);
for (const r of purged.retired) console.log(`  retired  ${r.role.toUpperCase().padEnd(4)} ${r.email}${r.refs ? `  (owns ${r.refs.applicants} applicant(s), ${r.refs.applications} app(s))` : ''}`);

const left = await db.prepare('SELECT COUNT(*) AS n FROM staff WHERE active = 1').get();
const local = await db.prepare("SELECT email FROM staff WHERE lower(email) LIKE '%@applywizz.local' AND active = 1").all();
console.log(`\nActive staff now: ${left.n}. Remaining active @applywizz.local fixtures: ${local.length}`);
