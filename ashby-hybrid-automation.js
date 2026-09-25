import fs from 'fs';
import path from 'path';
import dotenv from 'dotenv';
import { chromium } from 'playwright-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { parseResume, findLatestResumePath } from './parse-resume.js';
import { fillUnsupportedFieldsFromResume } from './genai-resume-filler.js';
import { scanFields, applyConfirmedAnswers } from './field-applier.js';
import { humanWarmup, moveToLocator } from './humanize.js';
import {
  buildApplicantProfile,
  getApplicantKey,
  saveJobStatus,
  addScreenshotToJob,
  loadApplicantProfile,
  getApplicantDirectory,
  ensureApplicantDirectory,
  safeSlug,
  getJobKey
} from './applicant-profile-store.js';

dotenv.config({ path: path.join(process.cwd(), '.env') });

if (!process.env.CHROME_PATH) {
  process.env.CHROME_PATH = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
}

chromium.use(StealthPlugin());

// No silent defaults: the job URL and resume MUST come from the caller
// (dashboard worker passes argv[2]/argv[3] + RESUME_PATH env). A baked-in
// personal resume/job constant is a privacy + correctness hazard.
const DEFAULT_JOB_URL = '';
const DEFAULT_RESUME_PATH = '';
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');

function parseRuntimeArgs() {
  const args = process.argv.slice(2);
  const values = {
    jobUrl: process.env.JOB_URL || '',
    resumePath: process.env.RESUME_PATH || '',
    applicantId: process.env.APPLICANT_ID || ''
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;

    if (arg === '--job-url' || arg === '--jobUrl') {
      values.jobUrl = args[index + 1] || values.jobUrl;
      continue;
    }

    if (arg === '--resume-path' || arg === '--resumePath') {
      values.resumePath = args[index + 1] || values.resumePath;
      continue;
    }

    if (arg === '--applicant-id' || arg === '--applicantId') {
      values.applicantId = args[index + 1] || values.applicantId;
      continue;
    }

    if (!values.jobUrl) {
      values.jobUrl = arg;
    } else if (!values.resumePath) {
      values.resumePath = arg;
    } else if (!values.applicantId) {
      values.applicantId = arg;
    }
  }

  return values;
}

const RUNTIME_ARGS = parseRuntimeArgs();
const APPLICANT_ID = RUNTIME_ARGS.applicantId || process.env.APPLICANT_ID || 'applicant';

function randomDelay(min = 35, max = 140) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

async function humanPause(min = 300, max = 1800, reason = 'activity') {
  const waitMs = randomDelay(min, max);
  console.log(`Human pause (${reason}): ${waitMs}ms`);
  await new Promise((resolve) => setTimeout(resolve, waitMs));
}

async function moveMouseHumanLike(page, targetLocator, offsetX = 0, offsetY = 0) {
  // Delegate to the shared human-behavior layer: curved bezier travel with
  // variable speed, jitter and overshoot-and-correct, instead of a straight line.
  await moveToLocator(page, targetLocator, { offsetX, offsetY }).catch(() => {});
}

async function humanClick(page, locator, options = {}) {
  await moveMouseHumanLike(page, locator, options.offsetX || 0, options.offsetY || 0);
  await page.waitForTimeout(randomDelay(150, 420));
  await locator.click({ force: options.force || false });
  await page.waitForTimeout(randomDelay(350, 900));
}

async function humanReadPause(page, min = 700, max = 2200) {
  await page.waitForTimeout(randomDelay(min, max));
}

async function humanScroll(page, deltaY = 420) {
  const jitter = randomDelay(-120, 120);
  await page.mouse.wheel(0, deltaY + jitter);
  await page.waitForTimeout(randomDelay(450, 1200));
}

async function captureStageScreenshot(page, stageName, extra = '', applicantIdOverride = APPLICANT_ID, jobUrlOverride = '') {
  const safeStage = stageName.replace(/[^a-z0-9-_]+/gi, '-').toLowerCase();
  const fileName = `${safeStage}${extra ? `-${extra}` : ''}-${RUN_ID}.png`;

  const applicantId = applicantIdOverride || APPLICANT_ID || 'applicant';
  const jobKey = getJobKey(jobUrlOverride || 'global');
  const applicantDir = ensureApplicantDirectory(applicantId);
  const screenshotDir = path.join(applicantDir, 'screenshots', jobKey);
  fs.mkdirSync(screenshotDir, { recursive: true });

  const applicantFilePath = path.join(screenshotDir, fileName);
  await page.screenshot({ path: applicantFilePath, fullPage: true });

  console.log(`Applicant-scoped screenshot stored: ${applicantFilePath}`);
  return applicantFilePath;
}

function normalize(value = '') {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isAshbyApplicationUrl(targetUrl = '') {
  const value = String(targetUrl || '').trim();
  if (!value) return false;

  try {
    const parsed = new URL(value);
    return /\/application(?:$|[/?#])/.test(parsed.pathname) || /src=linkedin|src=linkedIn|application\?/.test(parsed.search || '');
  } catch (error) {
    return /\/application(?:$|[/?#])/.test(value) || /application\?/.test(value);
  }
}

function resolveResumePath(customPath) {
  if (customPath) return customPath;

  if (DEFAULT_RESUME_PATH && fs.existsSync(DEFAULT_RESUME_PATH)) return DEFAULT_RESUME_PATH;

  const found = findLatestResumePath(process.cwd());
  if (found) return found;

  return null;
}

function resolveApplicantIdFromResume(resumeData = {}, resumePath = '', jobUrl = '') {
  if (RUNTIME_ARGS.applicantId || process.env.APPLICANT_ID) {
    return (RUNTIME_ARGS.applicantId || process.env.APPLICANT_ID || '').trim() || 'applicant';
  }

  const applicantKey = getApplicantKey(resumeData, resumePath, jobUrl);
  if (applicantKey && applicantKey !== 'applicant') return applicantKey;

  if (resumeData?.contact?.email) return safeSlug(resumeData.contact.email, 'applicant');
  return 'applicant';
}

function normalizeApplicantPayload(applicantPayload = {}) {
  const client = applicantPayload.client || {};
  const additional = applicantPayload.additional_information || {};

  return {
    applywizz_id: applicantPayload.applywizz_id || client.applywizz_id || additional.applywizz_id || '',
    applicant_id: applicantPayload.applicant_id || client.applywizz_id || additional.applywizz_id || '',
    personal: {
      name: applicantPayload.full_name || client.full_name || additional.full_name || '',
      firstName: applicantPayload.first_name || client.first_name || '',
      lastName: applicantPayload.last_name || client.last_name || '',
      email: applicantPayload.personal_email || client.personal_email || additional.personal_email || ''
    },
    contact: {
      email: applicantPayload.personal_email || client.personal_email || additional.personal_email || '',
      phone: applicantPayload.phone || client.whatsapp_number || client.callable_phone || additional.primary_phone || '',
      whatsapp: client.whatsapp_number || additional.whatsapp_number || '',
      mobile: client.callable_phone || additional.primary_phone || ''
    },
    education: Array.isArray(client.education) ? client.education : [],
    skills: Array.isArray(client.job_role_preferences) ? client.job_role_preferences : [],
    projects: Array.isArray(additional.projects) ? additional.projects : [],
    experience: additional.experience ? [additional.experience] : [],
    answers: {
      locationPreference: client.location_preferences || additional.state_of_residence || '',
      workAuthorization: client.visa_type || additional.eligible_to_work_in_us || '',
      sponsorship: client.sponsorship || additional.require_future_sponsorship || '',
      rolePreference: Array.isArray(client.job_role_preferences) ? client.job_role_preferences : []
    },
    raw: applicantPayload
  };
}

function buildApplicantProfileFromPayload(applicantPayload = {}, resumePath = '', jobUrl = '') {
  const normalized = normalizeApplicantPayload(applicantPayload);
  const applicantId = resolveApplicantIdFromResume(normalized, resumePath, jobUrl);
  const merged = buildApplicantProfile({
    personal: normalized.personal,
    contact: normalized.contact,
    education: normalized.education,
    skills: normalized.skills,
    projects: normalized.projects,
    experience: normalized.experience,
    answers: normalized.answers
  }, resumePath, jobUrl);

  return { applicantId, profile: merged };
}

function deepMergeApplicantData(baseData = {}, dbData = {}) {
  return {
    ...baseData,
    ...dbData,
    personal: { ...(baseData.personal || {}), ...(dbData.personal || {}) },
    contact: { ...(baseData.contact || {}), ...(dbData.contact || {}) },
    education: Array.isArray(dbData.education) && dbData.education.length
      ? dbData.education
      : Array.isArray(baseData.education)
        ? baseData.education
        : [],
    experience: Array.isArray(dbData.experience) ? dbData.experience : (Array.isArray(baseData.experience) ? baseData.experience : []),
    skills: Array.isArray(dbData.skills) ? dbData.skills : (Array.isArray(baseData.skills) ? baseData.skills : []),
    projects: Array.isArray(dbData.projects) ? dbData.projects : (Array.isArray(baseData.projects) ? baseData.projects : [])
  };
}

function loadApplicantDatabaseProfile() {
  const candidatePaths = [
    process.env.APPLICANT_DB_PATH,
    process.env.APPLICATION_DB_PATH,
    process.env.PERSON_PROFILE_PATH,
    process.env.ASHBY_DB_PATH
  ].filter(Boolean);

  for (const candidate of candidatePaths) {
    try {
      if (!fs.existsSync(candidate)) continue;
      const data = JSON.parse(fs.readFileSync(candidate, 'utf8'));
      if (data && typeof data === 'object') {
        return data;
      }
    } catch (error) {
      console.log(`Database profile skipped: ${candidate} could not be parsed (${error.message})`);
    }
  }

  return {};
}

function chooseResumeValue(resumeData, fieldText = '', fieldType = '') {
  const text = normalize(fieldText);
  if (!text) return '';

  const applicantData = resumeData || {};

  if (fieldType === 'email' || /email/.test(text)) return applicantData.contact?.email || '';
  if (fieldType === 'tel' || /phone|mobile|contact|number/.test(text)) return applicantData.contact?.phone || '';
  if (/first name/.test(text)) return applicantData.personal?.firstName || '';
  if (/last name/.test(text)) return applicantData.personal?.lastName || '';
  if (/full name|name/.test(text)) return applicantData.personal?.name || '';
  if (/degree|education|school|college|university/.test(text)) return (applicantData.education || []).join(', ') || '';
  if (/skills?|tools?|languages?|technologies?/.test(text)) return (applicantData.skills || []).join(', ') || '';
  if (/project|portfolio|work|experience/.test(text)) return (applicantData.projects || []).join(', ') || (applicantData.experience || []).join(', ') || '';

  return '';
}

function isSupportedResumeField(fieldText = '', fieldType = '') {
  const text = normalize(fieldText);
  const unsupportedPrompt = /experience|project|llm|model|skill|technology|cover letter|resume|portfolio|linkedin|github|website|sponsorship|authorization/;
  if (unsupportedPrompt.test(text)) return false;

  return fieldType === 'email' || fieldType === 'tel' ||
    /email|phone|mobile|\bname\b|degree|education|school|college|university|qualification/.test(text);
}

async function humanTypeValue(page, locator, value) {
  const text = String(value || '').trim();
  if (!text) return false;

  await moveMouseHumanLike(page, locator, randomDelay(-25, 25), randomDelay(-18, 22));
  await page.waitForTimeout(randomDelay(120, 260));
  await locator.focus();
  await locator.click({ trial: true }).catch(() => {});

  const existingValue = await locator.inputValue().catch(() => '');
  if (existingValue) {
    for (let i = 0; i < existingValue.length; i += 1) {
      await page.keyboard.press('Backspace', { delay: randomDelay(60, 180) });
      if (Math.random() < 0.25) {
        await page.waitForTimeout(randomDelay(40, 120));
      }
    }
  }

  for (const char of text) {
    const delay = randomDelay(90, 260);
    await page.keyboard.type(char, { delay });

    if (Math.random() < 0.22) {
      await page.waitForTimeout(randomDelay(160, 420));
    }
  }

  await page.waitForTimeout(randomDelay(550, 1400));
  return true;
}

async function waitForSubmissionOutcome(page) {
  const successMessage = page.getByText(
    /application has been received|thank you for your interest|application submitted|success/i
  ).first();
  const validationMessage = page.getByText(
    /your form has errors|missing entry for required field|please correct|required field|missing required fields|fill in the required fields/i
  ).first();

  let lastBannerText = '';
  for (let attempt = 0; attempt < 30; attempt += 1) {
    const bannerText = await page.locator('body').textContent().catch(() => '').then((text) => (text || '').trim());
    if (bannerText) {
      lastBannerText = bannerText;
    }

    if (await successMessage.isVisible().catch(() => false)) {
      console.log('Submission success acknowledgement detected.');
      return { status: 'success', bannerText: lastBannerText };
    }

    if (await validationMessage.isVisible().catch(() => false)) {
      const validationText = await validationMessage.textContent().catch(() => '') || lastBannerText || 'Validation message detected after submit.';
      console.log(`Missing or invalid field message detected after submit: ${validationText}`);
      return { status: 'missing-fields', bannerText: validationText };
    }

    await page.waitForTimeout(500);
  }

  return { status: null, bannerText: lastBannerText };
}

async function findApplyForThisJobButton(page) {
  const locatorGroups = [
    page.getByRole('link', { name: /apply for this job/i }),
    page.getByRole('button', { name: /apply for this job/i }),
    page.getByRole('link', { name: /apply/i }),
    page.getByRole('button', { name: /apply/i }),
    page.locator('a[href*="/application"]').filter({ hasText: /apply/i }),
    page.locator('a').filter({ hasText: /apply for this job/i }),
    page.locator('button').filter({ hasText: /apply for this job/i }),
    page.locator('a, button').filter({ hasText: /apply/i })
  ];

  for (let attempt = 0; attempt < 40; attempt += 1) {
    for (const locator of locatorGroups) {
      const count = await locator.count().catch(() => 0);
      if (count === 0) continue;

      const first = locator.first();
      const visible = await first.isVisible().catch(() => false);
      if (visible) {
        await moveMouseHumanLike(page, first, randomDelay(-30, 30), randomDelay(-20, 25));
        await page.waitForTimeout(randomDelay(280, 900));
        return first;
      }
    }

    await humanScroll(page, 420);
  }

  return null;
}

async function skipAutofillAndUploadShortcuts(page) {
  const skipMatchers = [
    /autofill from resume/i,
    /upload file/i,
    /resume autofill/i,
    /upload your resume/i
  ];

  const candidates = page.locator('button, a, input[type="button"], input[type="submit"]').filter({ hasText: /autofill|upload|resume/i });
  const count = await candidates.count().catch(() => 0);

  for (let i = 0; i < count; i += 1) {
    const candidate = candidates.nth(i);
    const text = await candidate.textContent().catch(() => '');
    if (skipMatchers.some(pattern => pattern.test(text))) {
      console.log(`Skipping shortcut UI: ${text.trim() || 'Resume shortcut'}`);
    }
  }
}

async function uploadProvidedResume(page, resumePath) {
  const fileInputs = page.locator('input[type="file"]');
  const count = await fileInputs.count().catch(() => 0);

  if (count === 0) {
    console.log('No file upload control was found for the provided resume.');
    return false;
  }

  let resumeInput = null;
  for (let index = 0; index < count; index += 1) {
    const candidate = fileInputs.nth(index);
    const fieldInfo = await candidate.evaluate((element) => {
      const label = element.closest('label') || document.querySelector(`label[for="${element.id}"]`);
      const ancestors = [];
      let current = element.parentElement;
      for (let level = 0; current && level < 8; level += 1) {
        ancestors.push({
          text: current.textContent || '',
          level
        });
        current = current.parentElement;
      }
      return {
        label: label?.textContent || '',
        ancestors,
        name: element.name || '',
        id: element.id || ''
      };
    }).catch(() => '');

    if (!fieldInfo || typeof fieldInfo !== 'object') continue;

    const directFieldText = `${fieldInfo.label} ${fieldInfo.name} ${fieldInfo.id}`;
    const matchingAncestor = fieldInfo.ancestors.find((ancestor) => {
      const text = `${directFieldText} ${ancestor.text}`;
      return /\bresume\b|\bcv\b/i.test(text) &&
        !/autofill|upload your resume here to autofill|cover letter/i.test(text);
    });

    if (matchingAncestor) {
      resumeInput = candidate;
      console.log(`Resume upload control found at field container level ${matchingAncestor.level}.`);
      break;
    }
  }

  if (!resumeInput) {
    console.log('A dedicated Resume upload field was not found. Autofill and Cover Letter uploads were left untouched.');
    return false;
  }

  await resumeInput.setInputFiles(resumePath);
  await page.waitForTimeout(1000);
  const uploadedFiles = await resumeInput.evaluate((element) => element.files?.length || 0).catch(() => 0);
  if (uploadedFiles === 0) {
    console.log('Resume upload did not attach a file.');
    return false;
  }

  console.log(`Provided resume uploaded: ${path.basename(resumePath)}`);
  return true;
}

async function getVisibleFormFields(page) {
  const fieldSelectors = 'input:not([type="hidden"]), textarea, select';
  const elements = await page.locator(fieldSelectors).all();
  const fields = [];

  for (const element of elements) {
    try {
      const info = await element.evaluate((el) => {
        const labelEl = el.closest('label') || document.querySelector(`label[for="${el.id}"]`);
        const surrounding = el.closest('div, section, fieldset');
        return {
          type: el.type || el.tagName.toLowerCase(),
          name: el.name || '',
          id: el.id || '',
          placeholder: el.placeholder || '',
          value: el.value || '',
          required: !!el.required,
          label: (labelEl ? labelEl.textContent : '') || (surrounding ? surrounding.textContent : '') || '',
          ariaLabel: el.getAttribute('aria-label') || '',
          disabled: !!el.disabled,
          visible: !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length),
          tagName: el.tagName.toLowerCase(),
          multiple: !!el.multiple,
          selectedText: el.options ? Array.from(el.options).filter((option) => option.selected).map((option) => option.textContent || '').join(', ') : ''
        };
      });

      if (!info || !info.visible || info.disabled || info.type === 'hidden') continue;
      fields.push({
        element,
        info,
        fieldText: `${info.label} ${info.name} ${info.id} ${info.placeholder} ${info.ariaLabel}`.trim(),
        value: info.value || info.selectedText || ''
      });
    } catch (error) {
      // Ignore uninspectable controls and continue.
    }
  }

  return fields;
}

async function fillFormFromResume(page, resumeData, resumePath) {
  const elements = await getVisibleFormFields(page);
  let resumeUploaded = false;

  console.log(`Scanning ${elements.length} form controls for resume-based filling`);

  for (let index = 0; index < elements.length; index += 1) {
    const { element, info, fieldText, value: currentFieldValue } = elements[index];
    try {
      const isPhoneField = info.type === 'tel' || /phone|mobile|contact number/.test(normalize(fieldText));

      if (isPhoneField && !resumeUploaded) {
        console.log('Reached the phone field. Uploading the provided resume first.');
        resumeUploaded = await uploadProvidedResume(page, resumePath);
      }

      if (currentFieldValue && currentFieldValue.trim()) continue;

      if (!isSupportedResumeField(fieldText, info.type)) {
        console.log(`Skipping unsupported resume field: ${fieldText || info.name || info.id || info.type}`);
        continue;
      }
      const value = chooseResumeValue(resumeData, fieldText, info.type);

      if (!value) {
        console.log(`Skipping field without matching resume data: ${fieldText || info.name || info.id || info.type}`);
        continue;
      }

      console.log(`Filling field: ${fieldText || info.name || info.id || info.type}`);
      await humanTypeValue(page, element, value);
      await page.waitForTimeout(randomDelay(500, 1000));
    } catch (error) {
      console.log(`Field skipped during fill: ${error.message}`);
    }
  }

  if (!resumeUploaded) {
    console.log('No phone field was found before the end of the form. Uploading the provided resume now.');
    await uploadProvidedResume(page, resumePath);
  }
}

async function getSubmitReadiness(page) {
  const overview = { requiredUnfilled: [], optionalUnfilled: [], total: 0 };
  const fields = await getVisibleFormFields(page);

  for (const { info, fieldText, value } of fields) {
    if (!fieldText && !info.name && !info.id) continue;
    overview.total += 1;

    const hasText = !!(value && value.trim());
    if (hasText) continue;

    if (info.required) {
      overview.requiredUnfilled.push(fieldText || info.name || info.id || info.type);
    } else {
      overview.optionalUnfilled.push(fieldText || info.name || info.id || info.type);
    }
  }

  return overview;
}

async function waitForFullFormCoverage(page, resumeData, resumePath, allowGenai = true) {
  const maxPasses = 3;

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    console.log(`\n--- Form coverage pass ${pass}/${maxPasses} ---`);
    await humanScroll(page, 420);
    await fillFormFromResume(page, resumeData, resumePath);
    await fillUnsupportedFieldsFromResume(page, resumePath, { allowGenai });
    await humanReadPause(page, 900, 1800);

    const readiness = await getSubmitReadiness(page);
    console.log(`Form status: ${readiness.total} visible inputs; required blanks: ${readiness.requiredUnfilled.length}; optional blanks: ${readiness.optionalUnfilled.length}`);

    if (readiness.requiredUnfilled.length === 0) {
      return readiness;
    }
  }

  return await getSubmitReadiness(page);
}

// Read the confirmed pre-Apply answers handed in by the dashboard worker
// (FIELD_ANSWERS_PATH -> JSON array of { field_key, question_text, value }).
// Returns null when unset/unreadable so the run falls back to live matching.
function loadConfirmedAnswers() {
  const p = process.env.FIELD_ANSWERS_PATH;
  if (!p) return null;
  try {
    const arr = JSON.parse(fs.readFileSync(p, 'utf8'));
    return Array.isArray(arr) && arr.length ? arr : null;
  } catch {
    return null;
  }
}

async function fillAshbyForm(jobUrl, resumePath) {
  console.log('\n=== Ashby application automation ===');
  console.log(`Job URL: ${jobUrl}`);
  console.log(`Resume path: ${resumePath}`);

  const baseResumeData = await parseResume(resumePath);
  const databaseData = loadApplicantDatabaseProfile();
  const resumeData = deepMergeApplicantData(baseResumeData, databaseData);
  const applicantId = resolveApplicantIdFromResume(resumeData, resumePath, jobUrl);
  const existingProfile = loadApplicantProfile(applicantId) || {};
  const applicantProfile = buildApplicantProfile({
    ...existingProfile,
    personal: { ...(existingProfile.personal || {}), ...(resumeData.personal || {}) },
    contact: { ...(existingProfile.contact || {}), ...(resumeData.contact || {}) },
    education: Array.isArray(resumeData.education) && resumeData.education.length ? resumeData.education : (existingProfile.education || []),
    skills: Array.isArray(resumeData.skills) && resumeData.skills.length ? resumeData.skills : (existingProfile.skills || []),
    projects: Array.isArray(resumeData.projects) && resumeData.projects.length ? resumeData.projects : (existingProfile.projects || []),
    experience: Array.isArray(resumeData.experience) && resumeData.experience.length ? resumeData.experience : (existingProfile.experience || []),
    answers: { ...(existingProfile.answers || {}) }
  }, resumePath, jobUrl);

  const applicantDir = ensureApplicantDirectory(applicantId);
  console.log(`Applicant profile persisted under: ${applicantDir}`);
  console.log('Resume parsed successfully. Merging resume and optional database-backed applicant data for field coverage.');

  const browser = await chromium.launch({
    headless: false,
    executablePath: process.env.CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--start-maximized']
  });

  const context = await browser.newContext({
    // viewport: null => the page fills the real (maximized) window instead of a
    // fixed 1920x1080 canvas that overflows a laptop screen and hides the bottom
    // of the form. Override with HEADLESS=true on a server where nothing is shown.
    viewport: null,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York'
  });

  const page = await context.newPage();

  try {
    console.log('\n--- Open application page ---');
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await humanReadPause(page, 1200, 2600);
    await humanWarmup(page); // wander + read before the first real interaction

    if (isAshbyApplicationUrl(jobUrl)) {
      console.log('Detected a direct Ashby application URL. Skipping the job overview CTA lookup and proceeding directly to the form.');
    } else {
      const applyButton = await findApplyForThisJobButton(page);
      if (!applyButton) {
        throw new Error('Could not find the "Apply for this Job" button after scrolling the job overview page');
      }

      console.log('Found the job apply CTA. Clicking it to move to the application page.');
      await applyButton.scrollIntoViewIfNeeded();
      await moveMouseHumanLike(page, applyButton, randomDelay(-30, 30), randomDelay(-15, 20));
      await page.waitForTimeout(randomDelay(500, 1200));
      await page.mouse.down();
      await new Promise((r) => setTimeout(r, randomDelay(50, 120)));
      await page.mouse.up();
      await page.waitForLoadState('networkidle');
      await humanReadPause(page, 3200, 5200);
    }

    console.log('\n--- Disable resume shortcuts and upload shortcuts ---');
    await skipAutofillAndUploadShortcuts(page);

    console.log('\n--- Fill the application form using only parsed resume details ---');
    await humanReadPause(page, 700, 1700);
    await fillFormFromResume(page, resumeData, resumePath);
    await humanReadPause(page, 1200, 2200);

    // Authoritative replay: the CA-reviewed draft answers (applicant_field_answers)
    // override whatever the live resume matcher guessed above. This is what makes
    // a CA-selected radio actually land, and fixes bogus live values (e.g. a "0"
    // graduation year). Skipped silently when no FIELD_ANSWERS_PATH is provided.
    const confirmedAnswers = loadConfirmedAnswers();

    // A draft means every question was already resolved once, deliberately:
    // record columns filled deterministically, the semantic mapper naming the
    // column per question, GenAI only for essays, blanks left for the CA. Re-running
    // the live resolver here would ask the model again for the same fields, so the
    // legacy GenAI pass only runs when there is no draft to replay.
    if (confirmedAnswers) {
      console.log('\n--- Apply confirmed pre-Apply answers (draft + CA review) ---');
      const replay = await applyConfirmedAnswers(page, confirmedAnswers);
      console.log(`Replayed ${replay.applied}/${replay.total} confirmed answer(s) as authoritative values.`);
      await humanReadPause(page, 900, 1800);
    } else {
      console.log('\n--- No draft supplied: fill remaining fields live from resume evidence ---');
      await fillUnsupportedFieldsFromResume(page, resumePath);
      await humanReadPause(page, 1500, 2800);
    }

    console.log('\n--- Submit the application ---');
    const readiness = await waitForFullFormCoverage(page, resumeData, resumePath, !confirmedAnswers);

    if (readiness.requiredUnfilled.length > 0) {
      console.log(`Required fields still appear blank: ${readiness.requiredUnfilled.join(', ')}. The app will surface a validation banner after submit if these remain incomplete.`);
    } else {
      console.log('All required fields are covered. Optional blanks will be left as-is if not supported by resume or database data.');
    }

    // Evidence shot #1: the FULLY-FILLED form, captured after every entry field
    // is populated and BEFORE the "Submit Application" button is clicked.
    // (Shot #2 is the post-submit acknowledgement captured further below.)
    const preSubmitPath = await captureStageScreenshot(page, 'pre-submit', '', applicantId, jobUrl)
      .catch(() => null);

    if (process.env.SUBMIT_DRY_RUN === 'true') {
      const dryPath = await captureStageScreenshot(page, 'dry-run-review', '', applicantId, jobUrl);
      saveJobStatus(applicantId, jobUrl, 'manual-review', {
        applicationStatus: 'manual-review',
        screenshot: dryPath,
        preSubmitScreenshot: preSubmitPath,
        reason: 'dry-run-no-submit',
        profile: applicantProfile
      });
      console.log('SUBMIT_DRY_RUN=true — form filled for inspection, NOT submitted.');
      return;
    }

    const submitButton = await page.locator('button:has-text("Submit"), button:has-text("Apply"), button[type="submit"]').first();
    const canSubmit = await submitButton.isVisible().catch(() => false);

    if (!canSubmit) {
      console.log('No submit button was found on the application page. Manual review is needed.');
      saveJobStatus(applicantId, jobUrl, 'manual-review', {
        applicationStatus: 'manual-review',
        profile: applicantProfile,
        preSubmitScreenshot: preSubmitPath,
        reason: 'submit-button-not-found'
      });
      return;
    }

    await submitButton.scrollIntoViewIfNeeded();
    await moveMouseHumanLike(page, submitButton, randomDelay(-40, 40), randomDelay(-20, 25));
    await humanReadPause(page, 3000, 6000);
    console.log('Review pause completed. Clicking Submit application now.');
    await page.mouse.down(); // real press at the hovered point (no cursor teleport)
    await new Promise((r) => setTimeout(r, randomDelay(50, 130)));
    await page.mouse.up();
    console.log('Submit application clicked. Waiting for success or missing-field acknowledgement.');
    const submissionOutcome = await waitForSubmissionOutcome(page);

    if (submissionOutcome.status === 'success') {
      const successPath = await captureStageScreenshot(page, 'application-success', '', applicantId, jobUrl);
      saveJobStatus(applicantId, jobUrl, 'success', { applicationStatus: 'success', screenshot: successPath, preSubmitScreenshot: preSubmitPath, bannerText: submissionOutcome.bannerText, profile: applicantProfile });
      console.log('Application submitted successfully and acknowledgement captured.');
    } else if (submissionOutcome.status === 'missing-fields') {
      const failPath = await captureStageScreenshot(page, 'application-missing-fields', '', applicantId, jobUrl);
      saveJobStatus(applicantId, jobUrl, 'failed', { applicationStatus: 'failed', screenshot: failPath, preSubmitScreenshot: preSubmitPath, bannerText: submissionOutcome.bannerText, missingFields: readiness.requiredUnfilled, profile: applicantProfile });
      console.log('Application was not submitted. Missing or invalid fields were captured from the validation banner.');
    } else {
      const fallbackPath = await captureStageScreenshot(page, 'application-outcome-unknown', '', applicantId, jobUrl);
      saveJobStatus(applicantId, jobUrl, 'unknown', { applicationStatus: 'unknown', screenshot: fallbackPath, preSubmitScreenshot: preSubmitPath, bannerText: submissionOutcome.bannerText, missingFields: readiness.requiredUnfilled, profile: applicantProfile });
      console.log('No success or missing-field acknowledgement appeared after submit. Screenshot captured for review.');
    }
  } catch (error) {
    console.error(`Automation failed: ${error.message}`);
    throw error;
  } finally {
    await browser.close();
  }
}

/* ------------------------------------------------------------------ *
   PRE-AUTOMATION SCAN: load the application form, capture every field  
   (question + control type + options) and dump it as JSON. No resume,   
   no filling, no submit. Enabled with SCAN_ONLY=true; output path via   
   FIELD_SCAN_OUT (defaults to ./field-scan.json).                        
 * ------------------------------------------------------------------ */
async function scanApplicationForm(jobUrl) {
  // The pre-scan captures form STRUCTURE only — nothing is typed and nothing is
  // submitted — so it can run in a hidden window. That is what lets the
  // dashboard's scan worker grind through links in the background without
  // stealing the operator's screen. Set SCAN_HEADLESS=false to watch it.
  const headless = process.env.SCAN_HEADLESS !== 'false';
  const browser = await chromium.launch({
    headless,
    executablePath: process.env.CHROME_PATH,
    args: ['--no-sandbox', '--disable-setuid-sandbox', ...(headless ? [] : ['--start-maximized'])]
  });
  const context = await browser.newContext({
    // viewport:null fills a real maximised window; headless has no window, so
    // give it a desktop-sized one (lazy sections must still render).
    viewport: headless ? { width: 1366, height: 900 } : null,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    locale: 'en-US',
    timezoneId: 'America/New_York'
  });
  const page = await context.newPage();
  try {
    console.log('\n--- [SCAN] Open application page ---');
    await page.goto(jobUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await humanReadPause(page, 1200, 2600);
    await humanWarmup(page); // behave like a person opening the page before scanning
    if (!isAshbyApplicationUrl(jobUrl)) {
      const applyButton = await findApplyForThisJobButton(page);
      if (applyButton) {
        await applyButton.scrollIntoViewIfNeeded();
        await applyButton.click();
        await page.waitForLoadState('networkidle');
        await humanReadPause(page, 3200, 5200);
      }
    }
    await skipAutofillAndUploadShortcuts(page).catch(() => {});
    await humanWarmup(page); // read the form before capturing it
    const fields = await scanFields(page);
    // The form is scoped to ONE posting, and the page itself names it. Without
    // this the dashboard keeps showing the "Role" placeholder created when the
    // link was first materialised, so a CA reviewing five open links cannot tell
    // them apart. Structure capture only — nothing is typed.
    const posting = await page.evaluate(() => {
      const text = (sel) => {
        const el = document.querySelector(sel);
        return el ? String(el.textContent || '').replace(/\s+/g, ' ').trim() : '';
      };
      return {
        h1: text('h1').slice(0, 180),
        jobTitle: text('[class*="jobTitle"], [class*="JobTitle"], [data-job-title]').slice(0, 180),
        docTitle: String(document.title || '').replace(/\s+/g, ' ').trim().slice(0, 200),
        headingAttr: String(document.querySelector('h1')?.getAttribute('title') || '').trim().slice(0, 180)
      };
    }).catch(() => ({}));
    const out = process.env.FIELD_SCAN_OUT || path.join(process.cwd(), 'field-scan.json');
    fs.writeFileSync(out, JSON.stringify({ url: jobUrl, scannedAt: new Date().toISOString(), posting, fields }, null, 2), 'utf8');
    console.log(`[SCAN] Captured ${fields.length} field(s)${posting.h1 || posting.jobTitle ? ` for "${posting.jobTitle || posting.h1}"` : ''} -> ${out}`);
    return fields;
  } finally {
    await browser.close();
  }
}

function createApplicantProfileForJob(jobUrl, resumePath, resumeData) {
  const applicantId = resolveApplicantIdFromResume(resumeData, resumePath, jobUrl);
  const profile = buildApplicantProfile({
    personal: resumeData.personal || {},
    contact: resumeData.contact || {},
    education: resumeData.education || [],
    skills: resumeData.skills || [],
    projects: resumeData.projects || [],
    experience: resumeData.experience || [],
    answers: {}
  }, resumePath, jobUrl);

  saveJobStatus(applicantId, jobUrl, 'pending', {
    applicantProfile: profile,
    resumePath,
    createdAt: new Date().toISOString()
  });

  return { applicantId, profile };
}

async function runApplicantsInParallel(applicantRecords = []) {
  if (!Array.isArray(applicantRecords) || applicantRecords.length === 0) {
    return [];
  }

  const jobUrl = RUNTIME_ARGS.jobUrl || DEFAULT_JOB_URL;
  if (!jobUrl) throw new Error('No job URL provided (pass argv[2] or set JOB_URL).');
  const tasks = applicantRecords.map((record) => {
    const normalized = normalizeApplicantPayload(record);
    const applicantId = resolveApplicantIdFromResume(normalized, '', jobUrl);
    const resumePath = record.resume_path || record.resume_url || resolveResumePath(RUNTIME_ARGS.resumePath || process.argv[3]) || DEFAULT_RESUME_PATH;
    if (!resumePath) throw new Error(`No resume resolved for ${applicantId || 'applicant'} (pass argv[3] or set RESUME_PATH).`);
    return fillAshbyForm(jobUrl, resumePath).catch((error) => ({
      applicantId,
      status: 'error',
      error: error.message,
      jobUrl
    }));
  });

  return Promise.all(tasks);
}

const applicantProfiles = [];

// Direct (manual) runs must be explicit. The dashboard worker always supplies
// argv[2]=url and argv[3]=resume (plus APPLICANT_ID / PERSON_PROFILE_PATH /
// FIELD_ANSWERS_PATH env), so it is unaffected. We no longer silently fall back
// to the built-in dev defaults (the hardcoded ramp job + a specific resume),
// which would otherwise apply the wrong candidate to the wrong job.
const jobUrl = RUNTIME_ARGS.jobUrl || process.argv[2] || '';
const explicitResumeArg = RUNTIME_ARGS.resumePath || process.argv[3] || '';
const resumePath = explicitResumeArg ? resolveResumePath(explicitResumeArg) : '';
const explicitApplicantId = RUNTIME_ARGS.applicantId || process.env.APPLICANT_ID || null;

console.log(`Target job URL: ${jobUrl}`);
console.log(`Resume file: ${resumePath || 'not found'}`);
if (explicitApplicantId) {
  console.log(`Applicant override: ${explicitApplicantId}`);
}

if (process.env.SCAN_ONLY === 'true') {
  if (!jobUrl) {
    console.error('SCAN_ONLY needs a job URL:  node ashby-hybrid-automation.js "<job-url>"');
    process.exit(1);
  }
  scanApplicationForm(jobUrl)
    .then(() => process.exit(0))
    .catch((error) => { console.error('Scan failed:', error); process.exit(1); });
} else {
if (!jobUrl || !resumePath) {
  console.error('Refusing to run with built-in defaults (that would use the hardcoded ramp job + resume).');
  console.error('Provide BOTH explicitly:  node ashby-hybrid-automation.js "<job-url>" "<resume-pdf-path>"');
  console.error('(or set JOB_URL / RESUME_PATH). Dashboard/worker runs supply these automatically.');
  process.exit(1);
}

const runnerMode = process.argv[4] || 'single';
if (runnerMode === 'parallel') {
  const tasks = applicantProfiles.map((profile) => {
    const normalized = normalizeApplicantPayload(profile);
    const applicantId = resolveApplicantIdFromResume(normalized, resumePath, jobUrl);
    const applicantDir = ensureApplicantDirectory(applicantId);
    console.log(`Parallel applicant run queued for ${applicantId} at ${applicantDir}`);
    return fillAshbyForm(jobUrl, resumePath).catch((error) => ({
      applicantId,
      status: 'error',
      error: error.message
    }));
  });

  Promise.all(tasks).then(() => {
    console.log('All applicant jobs finished in parallel.');
  }).catch((error) => {
    console.error('Parallel job runner failed:', error);
    process.exit(1);
  });
} else {
  const normalizedPayload = applicantProfiles[0] ? normalizeApplicantPayload(applicantProfiles[0]) : { contact: {}, personal: {} };
  const forcedApplicantId = explicitApplicantId || resolveApplicantIdFromResume(normalizedPayload, resumePath, jobUrl);
  const applicantDir = ensureApplicantDirectory(forcedApplicantId);
  console.log(`Single applicant run using identity: ${forcedApplicantId} -> ${applicantDir}`);

  fillAshbyForm(jobUrl, resumePath).catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });
}
}