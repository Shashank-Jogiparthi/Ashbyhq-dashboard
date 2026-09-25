// Apply the hosted (Supabase Postgres) schema from db/schema.supabase.sql.
//
//   node ashbyhq-dashboard/scripts/init-supabase.js            # idempotent apply
//   node ashbyhq-dashboard/scripts/init-supabase.js --reset    # DROP the app
//     tables first (destructive; empty/new projects only)
//
// Reads SUPA_DB_URL (or SUPA_HOST/PORT/USER/PASSWORD/DATABASE) from .env.
import dotenv from 'dotenv';
import pg from 'pg';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.resolve(__dirname, '..', '..', '.env') });

const SCHEMA_PATH = path.resolve(__dirname, '..', 'db', 'schema.supabase.sql');
const RESET = process.argv.includes('--reset');

// Every table this app owns, children first for a clean cascade drop.
const APP_TABLES = [
  'automation_runs', 'applicant_field_answers', 'application_events', 'applications',
  'applicant_joblinks', 'applicants', 'job_link_fields', 'job_links',
  'sessions', 'otp_codes', 'ams', 'staff', 'system_state'
];

function config() {
  const base = {
    ssl: process.env.SUPA_SSL === 'false' ? undefined : { rejectUnauthorized: false },
    connectionTimeoutMillis: 15000
  };
  if (process.env.SUPA_DB_URL) return { connectionString: process.env.SUPA_DB_URL, ...base };
  if (!process.env.SUPA_HOST) {
    throw new Error('Supabase not configured: set SUPA_DB_URL or SUPA_HOST/ SUPA_USER / SUPA_PASSWORD / SUPA_DATABASE in .env');
  }
  return {
    host: process.env.SUPA_HOST,
    port: Number(process.env.SUPA_PORT || 5432),
    user: process.env.SUPA_USER,
    password: process.env.SUPA_PASSWORD,
    database: process.env.SUPA_DATABASE || 'postgres',
    ...base
  };
}

const client = new pg.Client(config());
await client.connect();
console.log('[connected]', process.env.SUPA_DB_URL ? 'via SUPA_DB_URL' : process.env.SUPA_HOST);

if (RESET) {
  for (const t of APP_TABLES) {
    await client.query(`DROP TABLE IF EXISTS "${t}" CASCADE`);
  }
  console.log('[reset] dropped', APP_TABLES.length, 'app tables');
}

await client.query(readFileSync(SCHEMA_PATH, 'utf8'));
console.log('[schema] applied', path.basename(SCHEMA_PATH));

const { rows: cols } = await client.query(`
  SELECT table_name, column_name, data_type
  FROM information_schema.columns
  WHERE table_schema = 'public'
    AND column_name IN ('active','answered','needs_genai','materialized','optional',
                        'options_json','profile_jsonb','id','created_at')
  ORDER BY table_name, column_name
`);
for (const r of cols) console.log(`  ${r.table_name}.${r.column_name}`.padEnd(46), r.data_type);

const { rows: missing } = await client.query(`
  SELECT t.name FROM (VALUES ${APP_TABLES.map((n) => `('${n}')`).join(',')}) AS t(name)
  WHERE NOT EXISTS (SELECT 1 FROM information_schema.tables
                    WHERE table_schema='public' AND table_name = t.name)
`);
console.log(missing.length ? `[MISSING] ${missing.map((m) => m.name).join(', ')}` : `[ok] all ${APP_TABLES.length} tables present`);

await client.end();
