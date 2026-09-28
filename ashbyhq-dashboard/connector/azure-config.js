/* Shared Azure CRM connection settings for every connector module
   (applicant-db.js, joblink-questions.js, awl-links.js). Keeping the pool
   config + pg bootstrap here avoids those modules importing each other. */

import { CRM_HOST_NAMES, CRM_URL_NAMES } from '../core/applicant-source.js';

// Re-exported so error messages in the connector modules name exactly the
// variables pgConfig() reads, never a stale copy of the list.
export { CRM_HOST_NAMES, CRM_URL_NAMES };

let _pgReady = null;

// Import pg once and force date/timestamp columns to come back as plain
// strings so we never mangle YYYY-MM-DD values through JS timezone parsing.
export function getPg() {
  if (!_pgReady) {
    _pgReady = import('pg').then(({ default: pg }) => {
      const identity = (v) => v;         // OID 1082=date, 1114=timestamp,
      pg.types.setTypeParser(1082, identity);   // 1184=timestamptz
      pg.types.setTypeParser(1114, identity);
      pg.types.setTypeParser(1184, identity);
      return pg;
    });
  }
  return _pgReady;
}

// The accepted variable names live in core/applicant-source.js, so "is this
// host able to read the CRM" has exactly one answer everywhere it is asked
// (the worker's fault classifier, the ingest warning, the DEV pane, this pool).
// A URL-only host is a real configuration - Railway and most managed-Postgres
// dashboards hand you one string rather than five PG* parts - but it must be a
// CRM-NAMED one: DATABASE_URL belongs to the platform's own database and is
// deliberately not read here.
const first = (names) => {
  for (const n of names) {
    const v = String(process.env[n] || '').trim();
    if (v) return v;
  }
  return '';
};

export function pgConfig() {
  const host = first(CRM_HOST_NAMES);
  const connectionString = first(CRM_URL_NAMES);
  if (!host && !connectionString) return null;
  const ssl = process.env.PGSSL !== 'false' ? { rejectUnauthorized: false } : false;
  // URL and no host: hand pg the string alone. Passing host/user/password as
  // empty strings would OVERRIDE the values parsed out of the URL.
  if (!host) return { connectionString, ssl };
  return {
    host,
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || '',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE || 'postgres',
    ssl,
    connectionString: connectionString || undefined
  };
}
