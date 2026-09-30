/* =====================================================================
   Work-history refresh (v3.7).

   Pulls the external per-CA activity feed (`{ca_mgmt_base}/api/ca/work-history`)
   for every active CA email and caches it into `ca_work_history`, keyed
   (work_date, awl_id, ca_email) so a re-pull upserts in place and is idempotent.

   The CA uuid for each row is resolved from the cached email against our roster
   (staff.email), and its OM (om_id) from that CA's manager_id edge — so the
   work-history view joins cleanly to the staff tree the directory already built.

   Everything is injectable (caEmailsImpl / workHistoryImpl) so verify:flow drives
   it with fixtures and never hits the network. If `ca_mgmt_base` is unset the
   external call degrades to { skipped:'not_configured' } and we write nothing,
   leaving the dashboard to serve whatever is already cached.
   ===================================================================== */
import { db } from '../db/index.js';
import { upsertCaWorkHistory, logEvent } from '../db/store.js';
import { caEmails, fetchAllWorkHistory } from './external-apis.js';
import { normalizeAwlId } from './applicant-db.js';

async function staffByEmail(email) {
  const e = String(email || '').toLowerCase().trim();
  if (!e) return null;
  return (await db.prepare('SELECT * FROM staff WHERE lower(email) = ?').get(e)) || null;
}

/**
 * Refresh the ca_work_history cache for [from, to] across every active CA email.
 */
export async function refreshWorkHistory({
  from,
  to,
  caEmailsImpl = caEmails,
  workHistoryImpl = fetchAllWorkHistory
} = {}) {
  const ce = await caEmailsImpl();
  if (!ce?.ok || ce?.skipped === 'not_configured') {
    return { skipped: 'not_configured', upserted: 0, cas: 0 };
  }
  const users = Array.isArray(ce.users) ? ce.users.filter((u) => u && u.email) : [];
  if (!users.length) return { skipped: 'no_ca_emails', upserted: 0, cas: 0 };

  const staffCache = new Map();
  let upserted = 0;
  let resolvedCa = 0;
  let errors = 0;

  for (const u of users) {
    let recs;
    try {
      const r = await workHistoryImpl({ caEmail: u.email, from, to });
      if (r?.skipped === 'not_configured') return { skipped: 'not_configured', upserted, cas: users.length };
      recs = Array.isArray(r?.records) ? r.records : [];
    } catch {
      errors += 1;
      continue;                                   // one CA's feed failing never aborts the refresh
    }

    for (const rec of recs) {
      const recEmail = String(rec.ca_email || u.email || '').toLowerCase();
      if (!staffCache.has(recEmail)) staffCache.set(recEmail, await staffByEmail(recEmail));
      const staff = staffCache.get(recEmail);
      const awlId = normalizeAwlId(rec.applywizz_id);
      if (!awlId || !rec.date) continue;

      await upsertCaWorkHistory({
        workDate: rec.date,
        awlId,
        caEmail: recEmail,
        caId: staff?.uuid ?? null,
        omId: staff?.manager_id ?? null,
        clientName: rec.client_name,
        clientEmail: rec.client_email,
        jobsApplied: rec.jobs_applied,
        emailsSubmitted: rec.emails_submitted,
        emailsRequired: rec.emails_required,
        status: rec.status,
        startTime: rec.start_time,
        endTime: rec.end_time,
        source: rec.source
      });
      upserted += 1;
      if (staff) resolvedCa += 1;
    }
  }

  await logEvent(null, 'work_history_refreshed', 'system', { from, to, cas: users.length, upserted, resolvedCa, errors });
  return { from, to, cas: users.length, upserted, resolvedCa, errors };
}
