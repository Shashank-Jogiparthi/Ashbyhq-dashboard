/* =====================================================================
   RESUME TEXT FOR THE DRAFT PASS.

   The pre-Apply draft is grounded on the CRM record, and a 34-column
   record cannot answer "describe the most impressive thing you built" -
   that is exactly what the resume says. The submit engine already parses
   the resume, but the review pane runs long before any browser exists, so
   the drafts were declining and dumping every narrative question on the
   CA. This module fetches the applicant's own resume (the S3 link stored in
   applicants.resume_address), parses the text once, and caches it on disk.

   PRIVACY: the cache is applicant data. It lives under data/resume-cache
   (git-ignored), one file per AWL-ID, and purgeResume() is called from the
   post-success erase so nothing outlives the application it came from.
   ===================================================================== */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
import { db } from './db/index.js';
import { __internals } from '../genai-resume-filler.js';

const { readResumeText } = __internals;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CACHE_DIR = process.env.RESUME_CACHE_DIR || path.join(HERE, 'data', 'resume-cache');
const TTL_MS = Number(process.env.RESUME_CACHE_TTL_MS || 24 * 60 * 60 * 1000);

// AWL-ids are user-facing strings ("AWL-31428"), but keep the file name safe
// anyway - it is derived from data that arrives from an external CRM.
const slug = (awlId) => String(awlId || '').replace(/[^A-Za-z0-9._-]/g, '').slice(0, 64) || 'unknown';

async function storedResumeAddress(awlId) {
  const row = await db.prepare('SELECT resume_address FROM applicants WHERE awl_id = ?').get(awlId);
  return String(row?.resume_address || '').trim();
}

function readCache(awlId) {
  const file = path.join(CACHE_DIR, `${slug(awlId)}.txt`);
  try {
    const stat = fs.statSync(file);
    if (Date.now() - stat.mtimeMs > TTL_MS) {
      // Expired means "read it again from the resume the CRM points at", so the
      // stale copy is deleted on the spot - parsed applicant text must not sit
      // on disk forever just because nobody opened the pane again.
      fs.rmSync(file, { force: true });
      return null;
    }
    const text = fs.readFileSync(file, 'utf8');
    return text.trim() ? text : null;
  } catch {
    return null;
  }
}

/**
 * Sweep every cached resume older than the TTL. Called once at boot so a
 * dashboard that stayed down through an applicant's whole queue does not keep
 * their resume text behind (the per-success purge is the primary erase).
 */
export function purgeStaleResumes() {
  let removed = 0;
  try {
    for (const name of fs.readdirSync(CACHE_DIR)) {
      const file = path.join(CACHE_DIR, name);
      if (Date.now() - fs.statSync(file).mtimeMs > TTL_MS) { fs.rmSync(file, { force: true }); removed += 1; }
    }
  } catch { /* nothing cached yet */ }
  return removed;
}

function writeCache(awlId, text) {
  try {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
    fs.writeFileSync(path.join(CACHE_DIR, `${slug(awlId)}.txt`), text);
  } catch { /* a cache miss is never a reason to fail a draft */ }
}

/** Drop an applicant's cached resume + download (called by the privacy purge). */
export function purgeResume(awlId) {
  const base = slug(awlId);
  let removed = 0;
  for (const ext of ['.txt', '.pdf']) {
    const file = path.join(CACHE_DIR, `${base}${ext}`);
    try { fs.rmSync(file); removed += 1; } catch { /* absent */ }
  }
  return removed;
}

/**
 * Parsed resume text for one applicant, or '' when there is nothing to parse.
 * Never throws: a draft pass without the resume is still useful (the record
 * alone answers every knock-out question), so the caller must not have to
 * special-case an S3 hiccup.
 */
export async function resumeTextFor(awlId, { log = () => {} } = {}) {
  const cached = readCache(awlId);
  if (cached) return cached;
  const address = await storedResumeAddress(awlId);
  if (!address) { log(`no resume address for ${awlId}`); return ''; }
  try {
    let pdfPath = address;
    if (/^https?:\/\//i.test(address)) {
      fs.mkdirSync(CACHE_DIR, { recursive: true });
      pdfPath = path.join(CACHE_DIR, `${slug(awlId)}.pdf`);
      const res = await fetch(address);
      if (!res.ok) { log(`resume download ${res.status} for ${awlId}`); return ''; }
      fs.writeFileSync(pdfPath, Buffer.from(await res.arrayBuffer()));
    } else if (!fs.existsSync(address)) {
      log(`resume not found at ${address}`);
      return '';
    }
    const text = await readResumeText(pdfPath);
    if (text) writeCache(awlId, text);
    return text || '';
  } catch (err) {
    log(`resume unavailable for ${awlId}: ${String(err.message || err).slice(0, 120)}`);
    return '';
  }
}
