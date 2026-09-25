// One-time Supabase Storage setup for run evidence screenshots.
//
// Creates the (public-read) bucket used by connector/supabase-storage.js and
// best-effort storage policies, using the SAME Postgres credentials already in
// .env (SUPA_DB_URL or SUPA_HOST/...) - no API key needed for this step.
//
//   cd ashbyhq-dashboard
//   npm run setup:storage
//
// Idempotent: safe to re-run. After this, put your service_role key in .env as
// SUPA_SERVICE_KEY=... so the worker can actually upload (it bypasses RLS).

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pg from 'pg';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '..', '.env') });        // dashboard-local first
dotenv.config({ path: path.join(here, '..', '..', '.env') });  // then repo root

const BUCKET = process.env.SUPA_SCREENSHOT_BUCKET || 'application-screenshots';

function clientOptions() {
  // Supabase's db.<ref>.supabase.co endpoint ships a valid CA-signed cert, so
  // verification is ON by default. If a corporate MITM proxy or the IPv6-only
  // endpoint breaks the handshake, set SUPA_TLS_INSECURE=true in .env to relax
  // it (matches db/index.js behaviour). SUPA_SSL=false disables TLS entirely.
  const insecure = /^(1|true|yes)$/i.test(process.env.SUPA_TLS_INSECURE || '');
  const sslOff = /^(false|0|no)$/i.test(process.env.SUPA_SSL || 'true');
  const ssl = sslOff ? false : (insecure ? { rejectUnauthorized: false } : true);

  if (process.env.SUPA_DB_URL) return { connectionString: process.env.SUPA_DB_URL, ssl };
  return {
    host: process.env.SUPA_HOST, port: Number(process.env.SUPA_PORT || 5432),
    database: process.env.SUPA_DATABASE || 'postgres',
    user: process.env.SUPA_USER, password: process.env.SUPA_PASSWORD,
    ssl,
    connectionTimeoutMillis: 15000
  };
}

const client = new pg.Client(clientOptions());

async function tryQuery(label, sql) {
  try {
    await client.query(sql);
    console.log(`  ✔ ${label}`);
    return true;
  } catch (err) {
    console.warn(`  ⚠ ${label}: ${String(err.message).trim().slice(0, 160)}`);
    return false;
  }
}

try {
  await client.connect();
  console.log(`Setting up Supabase Storage bucket "${BUCKET}"...`);

  // 1. The bucket itself, marked public so plain object URLs serve the images.
  await tryQuery(`create bucket "${BUCKET}" (public read)`, `
    insert into storage.buckets (id, name, public)
    values ('${BUCKET}', '${BUCKET}', true)
    on conflict (id) do update set public = true`);

  // 2. Public-read policy (needed on projects where the built-in policies do
  //    not already cover public buckets; ownership errors are reported, not fatal).
  await tryQuery('public SELECT policy on storage.objects', `
    drop policy if exists "${BUCKET}_public_read" on storage.objects;
    create policy "${BUCKET}_public_read" on storage.objects
      for select to public using (bucket_id = '${BUCKET}')`);

  // 3. Sanity check: the bucket row must exist for uploads to succeed.
  const row = await client.query('select id, public from storage.buckets where id = $1', [BUCKET]);
  if (row.rowCount) {
    console.log(`\nBucket ready: ${BUCKET} (public=${row.rows[0].public}).`);
    console.log(`Public URL pattern: ${process.env.SUPA_PROJECT_URL}/storage/v1/object/public/${BUCKET}/<awl>/<link>/<run>-pre-submit.png`);
  } else {
    console.error(`\n✗ Could not create/read bucket "${BUCKET}" via SQL.`);
    console.error('  Create it in the Supabase dashboard instead: Storage → New bucket →');
    console.error(`  name "${BUCKET}", access: public, then re-run this script.`);
    process.exitCode = 1;
  }
  if (!process.env.SUPA_SERVICE_KEY && !process.env.SUPA_S3_ACCESS_KEY) {
    console.log('\nNext step (manual, secret): uploads need ONE of these in .env -');
    console.log('  a) S3 protocol (preferred): Project Settings → S3 Integrations →');
    console.log('     SUPA_S3_ENDPOINT / SUPA_S3_REGION / SUPA_S3_ACCESS_KEY / SUPA_S3_SECRET_KEY');
    console.log('  b) REST: Project Settings → API → "service_role" as SUPA_SERVICE_KEY');
    console.log('Until then the worker records "storage_not_configured" instead of uploading.');
  }
} catch (err) {
  console.error('setup-storage failed:', String(err.message || err).slice(0, 200));
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
