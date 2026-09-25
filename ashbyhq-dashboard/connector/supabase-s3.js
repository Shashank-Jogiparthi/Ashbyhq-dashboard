/* =====================================================================
   Supabase Storage — S3 protocol client (screenshot evidence).

   Supabase exposes the same buckets over an S3-compatible endpoint:
     https://<ref>.storage.supabase.co/storage/v1/s3   (region ap-south-1 etc.)

   That endpoint does NOT accept the service_role JWT — it wants an S3
   access key id + secret from  Project Settings -> S3 Integrations. Those
   credentials are used here to sign a plain AWS Signature V4 request.

   The signature is built with node:crypto only (no @aws-sdk dependency):
   canonical request -> string to sign -> derived signing key -> HMAC.
   Object keys are identical to the REST layout, so an object written here is
   readable through the public REST URL the dashboard already renders:
     https://<ref>.storage.supabase.co/storage/v1/object/public/<bucket>/<key>

   Requires: SUPA_S3_ENDPOINT, SUPA_S3_REGION, SUPA_S3_ACCESS_KEY, SUPA_S3_SECRET_KEY
   ===================================================================== */
import crypto from 'node:crypto';

const ALGO = 'AWS4-HMAC-SHA256';
const SERVICE = 's3';

export function s3Config() {
  const endpoint = process.env.SUPA_S3_ENDPOINT;
  const region = process.env.SUPA_S3_REGION;
  const accessKeyId = process.env.SUPA_S3_ACCESS_KEY;
  const secretAccessKey = process.env.SUPA_S3_SECRET_KEY;
  if (!endpoint || !region || !accessKeyId || !secretAccessKey) return null;
  let url;
  try {
    url = new URL(String(endpoint).replace(/\/+$/, '') + '/');
  } catch {
    return null;
  }
  return {
    host: url.host,
    origin: `${url.protocol}//${url.host}`,
    prefix: url.pathname.replace(/\/+$/, ''),      // e.g. /storage/v1/s3
    region,
    accessKeyId,
    secretAccessKey,
    bucket: process.env.SUPA_SCREENSHOT_BUCKET || 'application-screenshots',
    // Public reads always go through the REST face, even on an S3-write setup.
    publicBase: process.env.SUPA_PUBLIC_URL
      || `${url.protocol}//${url.host}/storage/v1/object/public`
  };
}

export function s3Configured() {
  return Boolean(s3Config());
}

const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const hmac = (key, data) => crypto.createHmac('sha256', key).update(data, 'utf8').digest();
const stamp = (d) => d.toISOString().replace(/[-:]|\.\d{3}/g, '');   // YYYYMMDDTHHMMSSZ

// S3 encodes each path segment individually ( '/' stays '/' ).
const encodePath = (p) => String(p).split('/').map((s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`)).join('/');

// Single source of truth for the request path: /<prefix>/<bucket>/<key>.
// The SAME encoded string goes into the canonical request and into the URL -
// any drift between the two is a SignatureDoesNotMatch.
const objectPath = (cfg, key) => `/${[cfg.prefix, cfg.bucket, key].join('/').split('/').filter(Boolean).join('/')}`;

function signedHeadersFor(cfg, { method, key, body, contentType }) {
  const datetime = stamp(new Date());
  const date = datetime.slice(0, 8);
  const canonicalUri = encodePath(objectPath(cfg, key));
  const payloadHash = sha256Hex(body || Buffer.alloc(0));
  const amzHeaders = {
    host: cfg.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': datetime
  };
  if (contentType) amzHeaders['content-type'] = contentType;
  const names = Object.keys(amzHeaders).sort();
  const canonicalHeaders = names.map((n) => `${n}:${String(amzHeaders[n]).trim()}\n`).join('');
  const signedHeaderList = names.join(';');
  const canonicalRequest = [method, canonicalUri, '', canonicalHeaders, signedHeaderList, payloadHash].join('\n');
  const scope = `${date}/${cfg.region}/${SERVICE}/aws4_request`;
  const stringToSign = [ALGO, datetime, scope, sha256Hex(Buffer.from(canonicalRequest, 'utf8'))].join('\n');
  const signingKey = hmac(hmac(hmac(hmac(`AWS4${cfg.secretAccessKey}`, date), cfg.region), SERVICE), 'aws4_request');
  const signature = crypto.createHmac('sha256', signingKey).update(stringToSign, 'utf8').digest('hex');
  if (process.env.SUPA_S3_DEBUG) {
    console.error('--- canonical request ---\n' + canonicalRequest + '\n--- string to sign ---\n' + stringToSign + '\n--- signature --- ' + signature);
  }
  return {
    datetime,
    payloadHash,
    headers: {
      ...amzHeaders,
      ...(contentType ? { 'content-type': contentType } : {}),
      authorization: `${ALGO} Credential=${cfg.accessKeyId}/${scope}, SignedHeaders=${signedHeaderList}, Signature=${signature}`
    }
  };
}

async function request(cfg, { method, key, body = null, contentType = null }) {
  const signed = signedHeadersFor(cfg, { method, key, body, contentType });
  const { headers } = signed;
  const url = `${cfg.origin}${encodePath(objectPath(cfg, key))}`;
  if (process.env.SUPA_S3_DEBUG) console.error(`${method} ${url}`);
  const res = await fetch(url, { method, headers, body: method === 'GET' ? undefined : (body || undefined) });
  if (!res.ok) {
    const txt = await res.text().catch(() => '');
    const err = /<Message>([^<]{0,300})/.exec(txt)?.[1] || txt.slice(0, 600);
    return { ok: false, status: res.status, error: `s3_${method.toLowerCase()}_failed ${res.status} ${err}`.trim(), serverBody: txt.slice(0, 2000) };
  }
  return { ok: true, status: res.status };
}

/** Upload a buffer (or file contents) under `key`. Returns its public URL. */
export async function s3Put({ key, body, contentType = 'image/png' }) {
  const cfg = s3Config();
  if (!cfg) return { ok: false, skipped: 's3_not_configured' };
  if (!key) return { ok: false, skipped: 'no_key' };
  const buf = Buffer.isBuffer(body) ? body : Buffer.from(String(body));
  const r = await request(cfg, { method: 'PUT', key, body: buf, contentType });
  if (!r.ok) return r;
  return { ok: true, url: `${cfg.publicBase}/${cfg.bucket}/${encodePath(key)}`, bytes: buf.length };
}

export async function s3Delete({ key }) {
  const cfg = s3Config();
  if (!cfg) return { ok: false, skipped: 's3_not_configured' };
  return request(cfg, { method: 'DELETE', key });
}

/** Read an object back (used by the connectivity self-test). */
export async function s3Get({ key }) {
  const cfg = s3Config();
  if (!cfg) return { ok: false, skipped: 's3_not_configured' };
  return request(cfg, { method: 'GET', key });
}
