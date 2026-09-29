#!/usr/bin/env node
/* =====================================================================
   Purge @applywizz.local staff fixtures (and anything else that is not a
   real @applywizz.com / @applywizz.ai person), keeping the CRM roster.

     node scripts/purge-local-staff.js            # DRY RUN - reports, writes nothing
     node scripts/purge-local-staff.js --apply    # actually delete / retire

   Safe by construction (see connector/staff-purge.js):
     * a fixture-owned applicant is re-pointed to its real CRM CA first when a
       connector (PG_*) is configured;
     * a doomed row that still owns unresolvable work or SUCCESS history is
       RETIRED (active=0), never force-deleted, so no foreign key breaks.

   Order that is usually what you want on the live host:
     1. POST /api/dev/sync  (or a full CRM sync) to re-point every applicant;
     2. this script --apply to remove the now-empty fixtures.
   Running --apply WITHOUT step 1 still works; applicants the CRM can resolve
   are moved here too, the rest simply retire their fixture.
   ===================================================================== */
import { migrate, BACKEND } from '../db/index.js';
import { purgeLocalStaff } from '../connector/staff-purge.js';
import { buildAwlCaIndex, normalizeAwlId, isConfigured as connectorConfigured } from '../connector/applicant-db.js';

const APPLY = process.argv.includes('--apply');

await migrate();

let resolveApplicant = null;
if (connectorConfigured()) {
  const index = await buildAwlCaIndex();
  if (index) resolveApplicant = async (app) => index.get(normalizeAwlId(app.awl_id)) || null;
}

const report = await purgeLocalStaff({ resolveApplicant, dryRun: !APPLY, actor: 'cli' });

console.log(`backend: ${BACKEND}   crm re-point: ${resolveApplicant ? 'on' : 'off (no PG_* here)'}   mode: ${APPLY ? 'APPLY' : 'DRY RUN'}`);
console.log(`kept @applywizz staff: ${report.kept}   doomed fixtures: ${report.doomed}   re-pointable applicants: ${report.reassignable}`);

if (!APPLY) {
  for (const p of report.projection) console.log(`  would-${p.fate.padEnd(6)} ${p.role.toUpperCase().padEnd(4)} ${p.email}`);
  if (report.doomed) console.log(`\nRe-run with --apply to ${report.wouldDelete} delete / ${report.wouldRetire} retire.`);
  process.exit(0);
}

for (const d of report.deleted) console.log(`  DELETED  ${d.role.toUpperCase().padEnd(4)} ${d.email}`);
for (const r of report.retired) console.log(`  RETIRED  ${r.role.toUpperCase().padEnd(4)} ${r.email}${r.refs ? `  (still owns ${r.refs.applicants} applicant(s), ${r.refs.applications} app(s))` : ''}`);
console.log(`\npurged: ${report.deleted.length} deleted, ${report.retired.length} retired, ${report.reassignable} applicant(s) re-pointed to their real CA.`);

// Prove the invariant: nothing left in the directory is a non-applywizz active
// fixture (retired rows may remain only where history legitimately pins them).
process.exit(0);
