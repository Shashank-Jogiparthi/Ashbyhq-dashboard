# Ashbyhq Automation Research - Quick Start Guide

## Getting Started with Ashbyhq Analysis

### Prerequisites
- Node.js installed (your project already has this)
- Playwright installed (already in your package.json)
- **A real browser binary** — `npm install` gives Playwright the library, not the
  browser. Run `npm run browser:install` (or `npx playwright install --with-deps
  chromium`), or point `CHROME_PATH` at an existing Chrome. The deployed Railway
  build does this for you; see *Deployment* at the bottom.
- Sample Ashbyhq job URLs from companies you'll work with — the **application
  form** URL (`jobs.ashbyhq.com/<company>/<posting-id>/application`), not a
  company careers/listing page (`<company>.com/careers/roles?ashby_jid=…`).
  Listing URLs are now refused rather than scanned into junk.

### Step 1: Install Dependencies (if needed)
```bash
npm install playwright-extra puppeteer-extra-plugin-stealth
```

### Step 2: Run the Analysis Script
```bash
node ashby-test-script.js https://jobs.ashbyhq.com/company-name/job-id
```

### Step 3: Review Results
Results will be saved in `ashby-analysis-results/` directory as JSON files.

## What the Script Analyzes

### ✅ Form Structure
- All input fields (text, email, file uploads, etc.)
- Field types and validation
- Required vs optional fields
- Field labels and placeholders

### ✅ Security Measures
- CAPTCHA presence (reCAPTCHA, Turnstile, etc.)
- Security tokens (CSRF, nonce, etc.)
- Rate limiting indicators
- Fraud detection scripts

### ✅ Submission Process
- Form method (POST/GET)
- Form action URL
- Encoding type
- AJAX vs traditional submission

## Sample URL Format

Ashbyhq job URLs typically look like:
```
https://jobs.ashbyhq.com/CompanyName/job-posting-id
```

Examples:
- `https://jobs.ashbyhq.com/Ashby/frontend-engineer`
- `https://jobs.ashbyhq.com/Stripe/software-engineer`
- `https://jobs.ashbyhq.com/Notion/product-designer`

## Research Workflow

### 1. Collect Sample URLs
Gather 3-5 different Ashbyhq job URLs from various companies to understand form variability.

### 2. Run Analysis Script
```bash
# Analyze each URL
node ashby-test-script.js https://jobs.ashbyhq.com/company1/job1
node ashby-test-script.js https://jobs.ashbyhq.com/company2/job2
node ashby-test-script.js https://jobs.ashbyhq.com/company3/job3
```

### 3. Document Findings
Use the research plan template to document your findings for each company.

### 4. Manual Testing
While the script provides automated analysis, also manually test:
- Try to submit a test application
- Note any CAPTCHA challenges
- Check success/error messages
- Test file upload process

### 5. Assess Feasibility
Use the scoring system in the research plan to assess overall automation feasibility.

## Key Things to Look For

### 🟢 Good Signs (Feasible)
- No CAPTCHA or simple CAPTCHA
- Consistent form structure
- Traditional form submission
- Clear success/error messages
- No complex security tokens

### 🟡 Medium Signs (Challenging but Possible)
- Moderate CAPTCHA (can be solved)
- Some form variability
- AJAX submission (needs network analysis)
- Basic security tokens
- Rate limiting (can be managed)

### 🔴 Bad Signs (Not Feasible)
- Complex CAPTCHA/verification
- Highly variable forms
- Complex security measures
- Strict rate limiting
- Heavy fraud detection

## Next Steps After Research

### If Feasible (Score 15+)
1. Design form field mapping system
2. Implement submission engine
3. Add success verification
4. Integrate with your existing Q&A database
5. Add to your Telegram bot workflow

### If Not Feasible (Score <15)
1. Consider semi-automated approach
2. Focus on form auto-fill only
3. Manual submission by user
4. Look into official API partnership
5. Continue with Indeed automation

## Integration with Your Existing System

If Ashbyhq proves feasible, you can integrate it into your existing architecture:

```javascript
// Add to your existing job discovery
const jobSources = {
  indeed: {
    discovery: 'job-discovery.js',
    automation: 'main.js'
  },
  ashby: {
    discovery: 'ashby-job-discovery.js', // New
    automation: 'ashby-automation.js'     // New
  }
};

// Extend your Q&A database
const platformSpecific = {
  indeed: {
    // Indeed-specific field mappings
  },
  ashby: {
    // Ashby-specific field mappings
  }
};
```

## Troubleshooting

### Script Issues
- **Page doesn't load**: Check URL is correct and publicly accessible
- **No fields found**: Form might load after user interaction, try manual navigation first
- **Browser crashes**: Try headless: false in script for debugging

### Analysis Issues
- **Inconsistent results**: Run analysis multiple times, Ashby might have A/B testing
- **Missing fields**: Some fields might be dynamically loaded, check JavaScript console
- **Security errors**: Some forms might have IP restrictions, try from different network

## Documentation

Keep detailed records of your findings:
- Screenshots of forms
- Network requests (use browser DevTools)
- Error messages encountered
- Success/failure patterns

This documentation will be crucial for building the automation system.

---

## Deployment (dashboard + workers) — the browser capability gate

Every host that runs `node ashbyhq-dashboard/server.js` also runs the scan and
apply workers, and the queues live in a **shared** database, so a host that
cannot drive a browser used to claim real work and file its own missing binary as
other people's failures (links "No scan output produced", applicants
"Engine process exited without a result"). That class is closed:

1. **Measure, don't assume.** On boot the host launches a headless browser, opens
   `about:blank` and remembers the verdict (`core/browser-probe.js` /
   `core/browser-check.js`). The check mirrors the engine's own search:
   `CHROME_PATH` → installed Chrome → Playwright's bundled Chromium.
2. **No browser, no claiming.** The apply worker will not claim a run. The scan
   worker may still answer from the local/shared question cache; anything that
   needs a real page load is **deferred** (attempt refunded, retried in
   `SCAN_DEFER_MS`, default 5 minutes) for a browser-capable host.
   `WORKER_ENABLED=false` remains a manual opt-out, but it can only pin a host
   **off** — it can never assert a capability the host does not have.
3. **A machine's problem stays the machine's problem.** If a run dies on a
   missing browser it is handed back `APPLYING → QUEUED`, the host's error is not
   stored as the applicant's failure, and a finished submission is never reopened.
4. **Provenance is visible.** `link_scan_jobs.scan_via` records whether a
   `✓ scanned` came from `local-cache`, `shared-cache` or a real `browser` scan,
   and the DEV pane shows the host's browser capability plus that tag — so an
   8-second cache answer can't be mistaken for a page load.
5. **Junk never lands.** A scan whose page reads like a listing/404, or that
   returns one field on a non-`/application` URL, is refused: nothing stored,
   nothing published to the shared cache.

**Build command** (`railway.json`) is now:

```bash
npm install && npm install --prefix ashbyhq-dashboard && npm run browser:install
```

`scripts/ensure-browser.js` is idempotent and never fails the build — a host it
cannot equip is pinned off by the gate with the reason in the DEV pane, which is
better than a deploy that does not start. Skip it with
`APPLYWIZZ_SKIP_BROWSER_INSTALL=true` when the image already has a browser.

**Before shipping**, from the repo root:

```bash
npm run verify:flow   # 80 assertions: gate, defer/refund, hand-back, cache
                      # provenance, junk refusal, publish path, workers
```

---

*Ready to start your Ashbyhq automation research!*