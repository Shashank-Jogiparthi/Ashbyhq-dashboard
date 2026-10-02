/* =====================================================================
   RESUME MIRRORED INTO OUR OWN SUPABASE STORAGE.

   The CRM keeps each applicant's resume at a public applywizz-prod S3 link,
   and applicants.resume_address stores exactly that link. The apply worker on
   Railway fetches it per run - but the bucket refuses Railway's egress IP with
   a 403, so the run files as "Resume unavailable: download 403" even though the
   PDF is fine. The object is readable from an ordinary network (the office /
   CRM-sync host); it is only Railway that is blocked.

   This module closes that gap: while a CRM sync runs on a host the bucket DOES
   allow, it downloads the resume and re-hosts it in our own Supabase Storage,
   then repoints applicants.resume_address at that copy. Both the apply worker
   and the draft resume-text reader read the SAME column, so once it holds a
   Supabase URL every Railway-side fetch succeeds - Supabase is the store
   Railway already reaches for screenshots.

   Resume SOURCE order (per the agreed flow): the client details API first, then
   the value the CRM sync already stored, and only if NEITHER yields a resume is
   it a genuine "resume not found".

   Every external dependency (download, upload, db, API) is injectable so the
   logic is unit-testable in verify:flow without touching the network. Mirrors
   are recorded in the resume_mirrors table so a re-sync reuses the cached copy
   instead of re-downloading, and a download/upload failure NEVER clobbers the
   applicant's existing pointer.
   ===================================================================== */
import { clientDetails } from './external-apis.js';
import { uploadResumeBuffer } from './supabase-storage.js';
import { s3Config } from './supabase-s3.js';
import {
  getApplicantResumeAddress, setApplicantResumeAddress,
  getResumeMirror, upsertResumeMirror, listResumeMirrorCandidates
} from '../db/store.js';

const HTTP_RE = /^https?:\/\//i;

/** True when a URL is served from our own Supabase Storage (the mirror). */
export function isOurCdnUrl(url) {
  const u = String(url || '');
  if (!u) return false;
  if (u.includes('/storage/v1/object/public/')) return true;
  const pb = s3Config()?.publicBase;
  if (pb && u.startsWith(pb)) return true;
  const proj = process.env.SUPA_PROJECT_URL ? String(process.env.SUPA_PROJECT_URL).replace(/\/+$/, '') : '';
  return Boolean(proj && u.startsWith(proj));
}

// The client-details payload is { client, additional_information }; the resume
// pointer can sit on either side under any of the three known column names.
function pickResumeUrl(doc) {
  const merged = { ...(doc?.additional_information || {}), ...(doc?.client || {}) };
  return String(merged.resume_url || merged.google_drive_resume_link || merged.resume_path || '').trim();
}

async function resumeUrlFromApi(awlId, impl) {
  try {
    const res = await impl(awlId);
    if (res && res.ok === false) return '';
    const data = res?.data ?? res;
    if (!data || typeof data !== 'object') return '';
    return pickResumeUrl(data);
  } catch {
    return '';
  }
}

async function defaultDownload(url) {
  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, status: res.status };
    const buffer = Buffer.from(await res.arrayBuffer());
    return { ok: true, status: res.status, buffer };
  } catch (err) {
    return { ok: false, status: 0, error: String(err.message || err).slice(0, 120) };
  }
}

/**
 * Mirror one applicant's resume into Supabase Storage and repoint
 * resume_address at the copy. Best-effort and idempotent; never throws.
 */
export async function stageResumeForAwl(awlId, opts = {}) {
  const {
    force = false,
    downloadImpl = defaultDownload,
    uploadImpl = uploadResumeBuffer,
    clientDetailsImpl = clientDetails,
    getStored = getApplicantResumeAddress,
    setAddress = setApplicantResumeAddress,
    getMirror = getResumeMirror,
    putMirror = upsertResumeMirror,
    log = () => {}
  } = opts;

  const id = String(awlId || '').trim();
  if (!id) return { ok: false, awlId: id, reason: 'no_awl_id' };

  const stored = String(await getStored(id) || '').trim();
  const apiResume = await resumeUrlFromApi(id, clientDetailsImpl);
  const sourceUrl = apiResume || stored;          // API first, CRM-table fallback
  const via = apiResume ? 'api' : 'table';

  if (!sourceUrl) return { ok: false, awlId: id, reason: 'no_resume_source' };
  if (!HTTP_RE.test(sourceUrl)) return { ok: false, awlId: id, reason: 'no_resume_source', note: 'non_url' };

  const mirror = await getMirror(id);
  // Already mirrored to this exact source and resume_address still points at
  // the copy -> nothing to do.
  if (!force && isOurCdnUrl(stored) && mirror && mirror.source_url === sourceUrl) {
    return { ok: true, awlId: id, url: mirror.cdn_url || stored, skipped: 'already_mirrored', via };
  }
  // Mirror exists for this source but a later sync repointed resume_address at
  // the raw S3 link -> restore the copy WITHOUT re-downloading.
  if (!force && mirror && mirror.source_url === sourceUrl && isOurCdnUrl(mirror.cdn_url)) {
    await setAddress(id, mirror.cdn_url);
    return { ok: true, awlId: id, url: mirror.cdn_url, restored: true, via };
  }

  const dl = await downloadImpl(sourceUrl);
  if (!dl || !dl.ok || !dl.buffer || !dl.buffer.length) {
    const why = dl?.status || dl?.error || 'err';
    log(`resume stage download failed for ${id}: ${why}`);
    // Preserve the existing pointer - the failure is surfaced, never silent.
    return { ok: false, awlId: id, reason: `download_failed ${why}`, source: sourceUrl, via };
  }

  const up = await uploadImpl({ awlId: id, buffer: dl.buffer, token: mirror?.token });
  if (!up || !up.ok || !up.url) {
    const why = up?.error || up?.skipped || 'err';
    log(`resume stage upload failed for ${id}: ${why}`);
    return { ok: false, awlId: id, reason: `upload_failed ${why}`, source: sourceUrl, via };
  }

  await setAddress(id, up.url);
  await putMirror({ awlId: id, sourceUrl, cdnUrl: up.url, token: up.token || null, bytes: dl.buffer.length });
  log(`resume mirrored for ${id} (${dl.buffer.length} bytes, via ${via})`);
  return { ok: true, awlId: id, url: up.url, bytes: dl.buffer.length, via };
}

/** Stage every candidate resume; returns an aggregate summary. */
export async function stageResumesForPending({
  limit = 500, force = false,
  listCandidates = listResumeMirrorCandidates, log = () => {}
} = {}) {
  const rows = await listCandidates(limit);
  const summary = { seen: 0, mirrored: 0, reused: 0, failed: 0, skipped_no_source: 0 };
  const failures = [];
  for (const r of rows || []) {
    const id = String(r?.awl_id || '').trim();
    if (!id) continue;
    summary.seen += 1;
    let res;
    try {
      res = await stageResumeForAwl(id, { force, log });
    } catch (e) {
      res = { ok: false, reason: `throw ${String(e.message || e).slice(0, 80)}` };
    }
    if (res.ok) {
      if (res.skipped === 'already_mirrored' || res.restored) summary.reused += 1;
      else summary.mirrored += 1;
    } else if (res.reason === 'no_resume_source') {
      summary.skipped_no_source += 1;
    } else {
      summary.failed += 1;
      if (failures.length < 20) failures.push({ awlId: id, reason: res.reason });
    }
  }
  return { ...summary, failures };
}
