/**
 * core/applicant-source.js — when a run has no resume, say WHO is missing.
 *
 * AWL-25663 failed with "Resume unavailable: no resume address". The person was
 * in the CRM the whole time: client_profiles had the row with resume_url
 * populated, clients_additional_info had the name. What was missing was
 * somewhere else - the host that ingested the link and later ran the apply had
 * no PGHOST set, so it never could have read those tables, and it created a
 * placeholder applicant (name = the AWL-ID, no email, no resume) instead. The
 * one sentence the failure produced blamed the applicant's data rather than the
 * machine that was never allowed to see it.
 *
 * Three causes look identical from the outside and need completely different
 * answers, so they must not share a message:
 *
 *   no connector here   -> the machine lacks a capability the run needs, exactly
 *                          like a missing browser: hand the row back and let a
 *                          host that CAN read the CRM take it.
 *   CRM has no row      -> nobody to apply; the AWL-ID is wrong or the person is
 *                          not in client_profiles yet. The CA/OPS chases it.
 *   row, no resume link -> the CRM record is incomplete. Someone with write
 *                          access to it fills resume_url in.
 *
 * Pure, so verify:flow can assert all three branches without a database.
 */

/**
 * The ONE list of environment names that mean "this host can read the CRM".
 * connector/azure-config.js builds its pool from exactly these, so a host that
 * was handed a single connection URL (what most managed-Postgres dashboards,
 * Railway included, actually generate) counts as configured - and a classifier
 * can never disagree with the code that opens the socket.
 *
 * DATABASE_URL / POSTGRES_URL are deliberately NOT in the list: on Railway and
 * Supabase deployments those names belong to the PLATFORM's own database, and
 * reading client_profiles from them would fail with "relation does not exist"
 * while pretending the CRM was reachable. Use a CRM-named variable instead.
 */
export const CRM_HOST_NAMES = ['PGHOST', 'AZURE_PG_HOST'];
export const CRM_URL_NAMES = ['PG_CONNECTION_STRING', 'AZURE_PG_URL', 'AZURE_DB_URL',
  'CRM_DB_URL', 'CRM_DATABASE_URL'];

const firstSet = (names, env) => {
  for (const n of names) {
    const v = String(env[n] || '').trim();
    if (v) return v;
  }
  return '';
};

/** True when this host has any of the accepted CRM credentials. */
export function crmConnectorPresent(env = process.env) {
  return Boolean(firstSet(CRM_HOST_NAMES, env) || firstSet(CRM_URL_NAMES, env));
}

/** The worker could not ask the CRM at all: this host has no connector. */
export function noConnectorHere(env = process.env) {
  return !crmConnectorPresent(env);
}

/**
 * What an operator needs to see on a host they cannot shell into: WHICH
 * variable names arrived, never their values. A missing name in this list is
 * the whole diagnosis, and a password never has to leave the machine it is on.
 */
export function describeConnectorEnv(env = process.env) {
  const seen = [...CRM_HOST_NAMES, ...CRM_URL_NAMES].filter((n) => String(env[n] || '').trim());
  return {
    present: seen,
    names: [...CRM_HOST_NAMES, ...CRM_URL_NAMES],
    summary: seen.length
      ? `CRM credentials present on this host: ${seen.join(', ')}`
      : `NO CRM connector on this host - none of ${[...CRM_HOST_NAMES, ...CRM_URL_NAMES].join(', ')} is set`
  };
}

/**
 * @param {object} r
 * @param {boolean} r.configured   this host has CRM credentials (isConfigured())
 * @param {number}  [r.seen]       rows the sync found for this AWL-ID (0 = none)
 * @param {string}  [r.syncError]  what the CRM read threw, if anything
 * @param {string}  r.awlId
 * @returns {{hostFault: boolean, reason: string}}
 */
export function classifyMissingResume({ configured = true, seen = null, syncError = '', awlId = '' } = {}) {
  if (!configured) {
    return {
      hostFault: true,
      reason: `No CRM connector on this host (none of ${[...CRM_HOST_NAMES, ...CRM_URL_NAMES].join(', ')} `
        + `is set) - it cannot read client_profiles, so ${awlId || 'this applicant'} has no resume here. ` 
        + `Another host with the connector must take this run.`
    };
  }
  if (syncError) {
    return {
      hostFault: true,
      reason: `CRM read for ${awlId || 'applicant'} failed (${String(syncError).slice(0, 140)}) `
        + `- nothing was fetched, so this is the host's problem, not the applicant's.`
    };
  }
  if (seen === 0) {
    return {
      hostFault: false,
      reason: `The CRM has no client_profiles or clients_additional_info row for ${awlId || 'this AWL-ID'} `
        + `- there is nobody to apply until that AWL-ID exists.`
    };
  }
  return {
    hostFault: false,
    reason: `client_profiles has a row for ${awlId || 'this AWL-ID'} but no resume in it `
      + `(resume_url, google_drive_resume_link and resume_path are all empty) - the record `
      + `needs the resume link before it can be applied.`
  };
}
