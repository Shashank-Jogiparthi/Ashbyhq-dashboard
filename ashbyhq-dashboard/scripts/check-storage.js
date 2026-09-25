/* =====================================================================
   Storage connectivity self-test  —  npm run storage:check

   Proves the screenshot pipeline end to end WITHOUT running an application:
     1. which credential backend is active (s3 | rest | none)
     2. a real 1x1 PNG is uploaded through uploadScreenshot() (the exact call
        worker/runner.js makes after a submission)
     3. the returned public URL is fetched and the bytes compared
     4. the object is indexed in storage.objects (Supabase's source of truth)
     5. the object is deleted again, so the bucket stays clean

   A public URL can still serve 200 for a while after step 5 — that is the
   Supabase CDN cache, not a failed delete; storage.objects is authoritative.
   ===================================================================== */
import fs from 'fs';
import os from 'os';
import path from 'path';
import zlib from 'zlib';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '..', '.env') });
dotenv.config({ path: path.join(here, '..', '..', '.env') });

const { uploadScreenshot, storageBackend } = await import('../connector/supabase-storage.js');
const { s3Delete, s3Config } = await import('../connector/supabase-s3.js');

const pass = [];
const fail = [];
const chk = (name, isOk, detail = '') => (isOk ? pass : fail).push(`${name}${detail ? ` — ${detail}` : ''}`);
const bucket = process.env.SUPA_SCREENSHOT_BUCKET || 'application-screenshots';

// A genuine 1x1 RGBA PNG, assembled with zlib so the bytes are valid image data.
function tinyPng() {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body) >>> 0);
    return Buffer.concat([len, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(1, 0);
  ihdr.writeUInt32BE(1, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;                                                  // 8-bit depth, RGBA
  const px = zlib.deflateSync(Buffer.from([0, 210, 80, 160, 255]));   // filter byte + pixel
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr), chunk('IDAT', px), chunk('IEND', Buffer.alloc(0))
  ]);
}

const backend = storageBackend();
chk(`backend active: ${backend}`, backend !== 'none',
  backend === 'none'
    ? 'set SUPA_S3_* (S3 Integrations) or SUPA_SERVICE_KEY (REST) in .env'
    : `bucket=${bucket}`);

let pool = null;
if (backend !== 'none') {
  const cfg = s3Config();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awl-storage-check-'));
  const tmpFile = path.join(tmpDir, 'health-check.png');
  fs.writeFileSync(tmpFile, tinyPng());
  const key = `_healthcheck/${Date.now()}-health-check.png`;

  try {
    const up = await uploadScreenshot({ filePath: tmpFile, destPath: key });
    chk('uploadScreenshot() accepted the file', up.ok === true, JSON.stringify(up).slice(0, 400));

    if (up.ok) {
      const res = await fetch(up.url);
      const bytes = Buffer.from(await res.arrayBuffer());
      chk('public URL is readable', res.status === 200, `${res.status} ${res.headers.get('content-type')}`);
      chk('bytes round-trip identical', bytes.equals(fs.readFileSync(tmpFile)), `${bytes.length} bytes`);

      if (cfg) {
        const pg = (await import('pg')).default;
        // Same convention as db/index.js: verify TLS unless SUPA_TLS_INSECURE=true.
        const relax = String(process.env.SUPA_TLS_INSECURE || '').toLowerCase() === 'true';
        pool = new pg.Pool({ connectionString: process.env.SUPA_DB_URL, ssl: { rejectUnauthorized: !relax } });
        const row = await pool.query(
          'SELECT name FROM storage.objects WHERE bucket_id = $1 AND name = $2', [bucket, key]);
        chk('object indexed in storage.objects', row.rowCount === 1, row.rows[0]?.name || 'not found');
        await pool.end();
        pool = null;
      }

      const del = await s3Delete({ key });
      chk('health-check object removed', del.ok === true, `${del.status} ${del.error || ''}`.trim());
      console.log(`\n  public url was: ${up.url}`);
      console.log('  (a cached 200 may persist briefly after deletion — that is the CDN)\n');
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

console.log(`storage check: PASS ${pass.length}  FAIL ${fail.length}`);
for (const m of pass) console.log('  \u2713 ' + m);
for (const m of fail) console.log('  \u2717 ' + m);
if (fail.length || pool) process.exitCode = 1;
