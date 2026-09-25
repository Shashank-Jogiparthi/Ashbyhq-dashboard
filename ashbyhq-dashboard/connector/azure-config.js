/* Shared Azure CRM connection settings for every connector module
   (applicant-db.js, joblink-questions.js, awl-links.js). Keeping the pool
   config + pg bootstrap here avoids those modules importing each other. */

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

export function pgConfig() {
  const host = process.env.PGHOST || process.env.AZURE_PG_HOST;
  if (!host) return null;
  return {
    host,
    port: Number(process.env.PGPORT || 5432),
    user: process.env.PGUSER || '',
    password: process.env.PGPASSWORD || '',
    database: process.env.PGDATABASE || 'postgres',
    ssl: process.env.PGSSL !== 'false' ? { rejectUnauthorized: false } : false,
    connectionString: process.env.PG_CONNECTION_STRING || undefined
  };
}
