/* =====================================================================
   Supabase Storage uploader (screenshot evidence).

   The automation engine captures two PNGs per applicant x job-link:
     1. pre-submit       — the fully-filled form, before clicking Submit
     2. acknowledgement  — the post-submit confirmation / validation banner

   Per the "no local records" policy those files must NOT stay on disk, so
   the worker uploads them here (into Supabase Storage — the one sanctioned
   store) and keeps only the public URL in the database. If Storage is not
   configured, uploadScreenshot() returns a graceful { ok:false, skipped }
   and the caller records the reason as text instead.

   Uses the Supabase Storage REST API via the global fetch (Node 22), so no
   extra dependency is added. Two credential styles are supported, in this
   order of preference:
     * S3 protocol  — SUPA_S3_ENDPOINT + SUPA_S3_REGION + SUPA_S3_ACCESS_KEY
                      + SUPA_S3_SECRET_KEY   (Project Settings -> S3 Integrations,
                      signed by connector/supabase-s3.js)
     * REST         — SUPA_PROJECT_URL + SUPA_SERVICE_KEY (service_role JWT)
     * SUPA_SCREENSHOT_BUCKET  optional bucket name (default 'application-screenshots')
       -> create the bucket once, public read: npm run setup:storage
   ===================================================================== */
import fs from 'fs';
import { s3Config, s3Put } from './supabase-s3.js';

const BUCKET = () => process.env.SUPA_SCREENSHOT_BUCKET || 'application-screenshots';

function storageConfig() {
  const s3 = s3Config();
  if (s3) return { backend: 's3', bucket: s3.bucket, s3 };
  const url = process.env.SUPA_PROJECT_URL;
  const key = process.env.SUPA_SERVICE_KEY || process.env.SUPA_STORAGE_KEY;
  if (!url || !key) return null;
  return { backend: 'rest', url: String(url).replace(/\/+$/, ''), key, bucket: BUCKET() };
}

export function storageConfigured() {
  return Boolean(storageConfig());
}

/** Which credential style is active — surfaced in the DEV storage status. */
export function storageBackend() {
  return storageConfig()?.backend || 'none';
}

// Upload one local file (from the soon-to-be-deleted temp run dir) to the
// configured bucket and return its public URL. Best-effort: every failure is
// folded into the returned object so a caller can log the reason and move on.
export async function uploadScreenshot({ filePath, destPath, contentType = 'image/png' } = {}) {
  const cfg = storageConfig();
  if (!cfg) return { ok: false, skipped: 'storage_not_configured' };
  if (!filePath || !fs.existsSync(filePath)) return { ok: false, skipped: 'file_missing' };
  if (!destPath) return { ok: false, skipped: 'no_dest_path' };

  const objectPath = String(destPath).replace(/^\/+/, '');
  try {
    const buf = fs.readFileSync(filePath);
    if (cfg.backend === 's3') {
      const r = await s3Put({ key: objectPath, body: buf, contentType });
      return r.ok ? { ok: true, url: r.url, via: 's3', bytes: r.bytes } : r;
    }
    const res = await fetch(`${cfg.url}/storage/v1/object/${cfg.bucket}/${objectPath}`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${cfg.key}`,
        apikey: cfg.key,
        'content-type': contentType,
        'x-upsert': 'true'
      },
      body: buf
    });
    if (!res.ok) {
      const txt = await res.text().catch(() => '');
      return { ok: false, error: `upload_failed ${res.status} ${txt.slice(0, 200)}` };
    }
    return { ok: true, url: `${cfg.url}/storage/v1/object/public/${cfg.bucket}/${objectPath}`, via: 'rest', bytes: buf.length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}
