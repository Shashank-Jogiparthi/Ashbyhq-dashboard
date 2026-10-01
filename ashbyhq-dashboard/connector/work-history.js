/* =====================================================================
   Work-history refresh (v3.7).

   Pulls the external per-CA activity feed (`{ca_mgmt_base}/api/ca/work-history`)
   for every active CA email and caches it into `ca_work_history`, keyed
   (work_date, awl_id, ca_email) so a re-pull upserts in place and is idempotent.

   The CA uuid for each row is resolved from the cached email against our roster
   (staff.email), and its OM (om_id) from that CA's manager_id edge — so the
   work-history view joins cleanly to the staff tree the directory already built.

   Assignment side-effect (visibility only): the work-history feed already names
   the CA actually working each AWL, resolved to a rostered staff uuid. That uuid
   — NOT the CRM clients_additional_info.career_associate_id ("the AWL's API key")
   — is what we point applicants.ca_id at, so a CA sees their whole book even when
   the CRM row is absent or its career_associate_id matches no roster member. The
   feed is DYNAMIC, not static: clients get shifted between CAs day to day (and on
   a handover, even within one day), so the current owner of an AWL is whoever has
   the MOST RECENT dated activity. We key on date then end/start time — never the
   first row we happened to iterate — and re-point the applicant to that CA (the
   open, non-SUCCESS applications follow the new owner inside upsertExternalApplicant;
   SUCCESS history is left untouched). We NEVER invent a CA (an email that is not
   rostered is skipped), and use materialize:false so no application or scan
   backlog is ever created.

   Everything is injectable (caEmailsImpl / workHistoryImpl) so verify:flow drives
   it with fixtures and never hits the network. If `ca_mgmt_base` is unset the
   external call degrades to { skipped:'not_configured' } and we write nothing,
   leaving the dashboard to serve whatever is already cached.
   ===================================================================== */
import { db } from '../db/index.js';
import { upsertCaWorkHistory, upsertExternalApplicant, logEvent } from '../db/store.js';
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
  const bestAssign = new Map(); // awlId -> { caId, omId, clientName, clientEmail, workDate }
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
      // The feed is dynamic: an AWL's client can be shifted to a different CA on a
      // later day, or handed over part-way through one day. The CURRENT owner is the
      // CA behind the MOST RECENT activity, so key on date then end/start time (ISO,
      // so a plain string compare is chronological) - not whichever CA row happened
      // to be iterated first. An un-rostered email (staff null) is never recorded, so
      // we never invent a CA.
      const stamp = `${rec.date}|${rec.end_time || rec.start_time || ''}`;
      const cur = bestAssign.get(awlId);
      if (staff?.uuid && (!cur || stamp > cur.stamp)) {
        bestAssign.set(awlId, {
          caId: staff.uuid, omId: staff.manager_id ?? null,
          clientName: rec.client_name, clientEmail: rec.client_email, stamp
        });
      }
    }
  }

  // Visibility-only assignment: point each attributed applicant at the CA who is
  // actually working them so their dashboard shows the whole book. materialize:
  // false stores any job links PENDING and creates NO application and NO scan
  // backlog - the same anti-flood contract buildCaData honours.
  let applicantsCreated = 0;
  let applicantsPointed = 0;
  for (const [awlId, a] of bestAssign) {
    try {
      const res = await upsertExternalApplicant({
        awlId,
        fullName: a.clientName || awlId,
        email: a.clientEmail || '',
        caId: a.caId,
        opsId: a.omId,
        materialize: false
      });
      if (res.created) applicantsCreated += 1; else applicantsPointed += 1;
    } catch { /* one bad AWL never aborts the refresh */ }
  }

  await logEvent(null, 'work_history_refreshed', 'system', { from, to, cas: users.length, upserted, resolvedCa, errors, assigned: bestAssign.size, applicantsCreated, applicantsPointed });
  return { from, to, cas: users.length, upserted, resolvedCa, errors, assigned: bestAssign.size, applicantsCreated, applicantsPointed };
}
