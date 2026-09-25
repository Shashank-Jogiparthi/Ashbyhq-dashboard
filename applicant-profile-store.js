import fs from 'fs';
import os from 'os';
import path from 'path';

export function safeSlug(value = '', fallback = 'applicant') {
  const normalized = String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .trim();

  return normalized || fallback;
}

export function getApplicantStoreRoot() {
  // Never default to a path inside the repo: applicant run artefacts must not
  // be persisted locally. The worker always passes an absolute temp dir; this
  // fallback keeps standalone runs writing to the OS temp area too.
  return path.resolve(process.env.APPLICANT_DATA_DIR
    || path.join(os.tmpdir(), 'applywizz-applicant-data'));
}

export function getApplicantDirectory(applicantId) {
  return path.join(getApplicantStoreRoot(), safeSlug(applicantId, 'unknown-applicant'));
}

export function getApplicantKey(applicantData = {}, resumePath = '', jobUrl = '') {
  const explicitApplicantId = process.env.APPLICANT_ID || applicantData?.applicant_id || applicantData?.applywizz_id || applicantData?.client?.applywizz_id || applicantData?.client?.id || '';
  if (explicitApplicantId) return safeSlug(String(explicitApplicantId).replace(/^AWL[-_]?/i, 'AWL-'), 'applicant');

  const directEmail = applicantData?.contact?.email || applicantData?.email || '';
  if (directEmail) return safeSlug(directEmail, 'applicant');

  const preferred = applicantData?.personal?.email || applicantData?.personal?.name || resumePath || jobUrl || 'unknown-applicant';
  return safeSlug(preferred, 'applicant');
}

export function ensureApplicantDirectory(applicantId) {
  const dir = getApplicantDirectory(applicantId);
  const folders = [
    dir,
    path.join(dir, 'jobs'),
    path.join(dir, 'screenshots')
  ];

  for (const folder of folders) {
    fs.mkdirSync(folder, { recursive: true });
  }

  return dir;
}

export function loadApplicantProfile(applicantId) {
  const profilePath = path.join(getApplicantDirectory(applicantId), 'profile.json');
  if (!fs.existsSync(profilePath)) return null;

  try {
    const raw = fs.readFileSync(profilePath, 'utf8');
    return JSON.parse(raw);
  } catch (error) {
    return null;
  }
}

export function saveApplicantProfile(applicantId, profile) {
  const applicantDir = ensureApplicantDirectory(applicantId);
  const profilePath = path.join(applicantDir, 'profile.json');
  const payload = {
    ...profile,
    applicantId,
    updatedAt: new Date().toISOString()
  };

  fs.writeFileSync(profilePath, JSON.stringify(payload, null, 2));
  return payload;
}

export function getJobKey(jobUrl = '') {
  const normalized = String(jobUrl || '').trim();
  if (!normalized) return 'unspecified-job';

  try {
    const url = new URL(normalized);
    return safeSlug(`${url.origin}${url.pathname}${url.search || ''}`, 'job');
  } catch (error) {
    return safeSlug(normalized, 'job');
  }
}

export function loadJobStatus(applicantId, jobUrl) {
  const jobFile = path.join(getApplicantDirectory(applicantId), 'jobs', `${getJobKey(jobUrl)}.json`);
  if (!fs.existsSync(jobFile)) return null;

  try {
    return JSON.parse(fs.readFileSync(jobFile, 'utf8'));
  } catch (error) {
    return null;
  }
}

export function saveJobStatus(applicantId, jobUrl, status, extra = {}) {
  const applicantDir = ensureApplicantDirectory(applicantId);
  const jobDir = path.join(applicantDir, 'jobs');
  const jobFile = path.join(jobDir, `${getJobKey(jobUrl)}.json`);

  const payload = {
    applicantId,
    jobUrl,
    jobKey: getJobKey(jobUrl),
    status,
    updatedAt: new Date().toISOString(),
    ...extra
  };

  fs.writeFileSync(jobFile, JSON.stringify(payload, null, 2));
  return payload;
}

export function addScreenshotToJob(applicantId, jobUrl, screenshotPath, stageName = 'stage') {
  const current = loadJobStatus(applicantId, jobUrl) || {
    applicantId,
    jobUrl,
    jobKey: getJobKey(jobUrl),
    screenshots: []
  };

  const screenshots = Array.isArray(current.screenshots) ? current.screenshots : [];
  screenshots.push({
    stage: stageName,
    path: screenshotPath,
    capturedAt: new Date().toISOString()
  });

  return saveJobStatus(applicantId, jobUrl, current.status || 'pending', {
    ...current,
    screenshots
  });
}

export function buildApplicantProfile(applicantData = {}, resumePath = '', jobUrl = '') {
  const applicantId = getApplicantKey(applicantData, resumePath, jobUrl);
  const baseProfile = loadApplicantProfile(applicantId) || {
    applicantId,
    createdAt: new Date().toISOString(),
    personal: {},
    contact: {},
    education: [],
    skills: [],
    projects: [],
    experience: [],
    answers: {},
    sourcePaths: {}
  };

  const merged = {
    ...baseProfile,
    applicantId,
    personal: {
      ...(baseProfile.personal || {}),
      ...(applicantData.personal || {})
    },
    contact: {
      ...(baseProfile.contact || {}),
      ...(applicantData.contact || {})
    },
    education: Array.isArray(applicantData.education) && applicantData.education.length
      ? applicantData.education
      : (Array.isArray(baseProfile.education) ? baseProfile.education : []),
    skills: Array.isArray(applicantData.skills) && applicantData.skills.length
      ? applicantData.skills
      : (Array.isArray(baseProfile.skills) ? baseProfile.skills : []),
    projects: Array.isArray(applicantData.projects) && applicantData.projects.length
      ? applicantData.projects
      : (Array.isArray(baseProfile.projects) ? baseProfile.projects : []),
    experience: Array.isArray(applicantData.experience) && applicantData.experience.length
      ? applicantData.experience
      : (Array.isArray(baseProfile.experience) ? baseProfile.experience : []),
    answers: {
      ...(baseProfile.answers || {}),
      ...(applicantData.answers || {})
    },
    sourcePaths: {
      ...(baseProfile.sourcePaths || {}),
      ...(resumePath ? { resumePath } : {}),
      ...(jobUrl ? { lastKnownJobUrl: jobUrl } : {})
    },
    profileReady: true,
    updatedAt: new Date().toISOString()
  };

  return saveApplicantProfile(applicantId, merged);
}
