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

1. **Measure, don't assume.** On boot the host launches a real browser, opens
   `about:blank` and remembers the verdict (`core/browser-probe.js` /
   `core/browser-check.js`). The check mirrors the engine's own search:
   `CHROME_PATH` → installed Chrome → Playwright's bundled Chromium.
2. **One verdict per MODE — apply and scan are different questions.** The engine
   opens a **headed** window for an application (best signal available to Ashby's
   anti-spam filter) and a **headless** page for a scan, so each mode is measured
   on its own terms. Answering both with one headless launch is how a deploy once
   called itself ready, claimed real applications and lost them at
   `browserType.launch: Target page, context or browser has been closed`.
3. **How an apply launches is a rule, not a setting** (`core/apply-mode.js`):
   an explicit `APPLY_HEADLESS`/`HEADLESS` wins in **both** directions; otherwise
   a linux host with no `DISPLAY`/`WAYLAND_DISPLAY` applies **headless** and any
   machine with a desktop applies **headed**. The worker resolves it once, hands
   the answer to the engine through the child's environment (the engine itself is
   never edited) and the probe measures that same mode — so probe, worker and run
   cannot disagree again, and a new host needs no variable set to behave.
4. **No browser, no claiming — and no more browsers than the host can hold.** The
   apply worker will not claim a run it cannot launch. How many it may run at once
   is measured too (`core/host-capacity.js`: available memory ÷ 512MB per browser,
   read from the container's cgroup limit because `os.totalmem()` reports the host
   *node*): `MAX_CONCURRENT_RUNS` is a ceiling that gets clamped, "unlimited" means
   "as many as fit", and a roomy laptop is unaffected. The scan worker takes at most
   half the budget — a scan that waits costs minutes and is deferred/refunded, an
   apply that dies costs a person. The scan worker may still answer from the local or
   shared question cache with no browser at all; anything needing a real page load is
   **deferred** (retried in `SCAN_DEFER_MS`, default 5 minutes) for a capable host.
   `WORKER_ENABLED=false` remains a manual opt-out, but it can only pin a host
   **off** — it can never assert a capability the host does not have.
5. **A machine's problem stays the machine's problem.** An application is only ever
   FAILED on evidence the **form was reached**. A run that dies on an unavailable
   browser, or is killed (or exits silently) without ever writing a result, is handed
   back `APPLYING → QUEUED` and **parked** for `APPLY_DEFER_MS` (default 5 min): the
   host's error is not stored as the applicant's failure, a finished submission is
   never reopened, and the same dead host cannot re-claim the row every poll tick —
   three simultaneous Chromiums on a 512MB container killed one run six seconds in
   and it had been filed as the applicant's FAILED application. When a run *did*
   reach the page but left no result, its own last printed line is recorded as the
   reason instead of "Engine process exited without a result". A CA's APPLY or a
   DEV's Retry clears the pause immediately: a human pressing the button means now.
6. **Provenance is visible.** `link_scan_jobs.scan_via` records whether a
   `✓ scanned` came from `local-cache`, `shared-cache` or a real `browser` scan,
   and the DEV pane shows the host's browser capability per mode, which launch
   mode an apply will use and why, plus that tag — so an 8-second cache answer
   can't be mistaken for a page load.
7. **Junk never lands.** A scan whose page reads like a listing/404, or that
   returns one field on a non-`/application` URL, is refused: nothing stored,
   nothing published to the shared cache.
8. **Ashby's own words are read, not shrugged at.** The engine only recognises two
   post-submit acknowledgements (success, missing fields) and stores everything else
   as `unknown` *with the page text*. `core/submission-banner.js` reads that text, so
   the red "flagged as possible spam" box is now recorded as exactly that — *not
   submitted, this host's network is what Ashby distrusted* — instead of PENDING
   "Outcome unclear" with an empty reason column. It stays PENDING for a human and is
   **never** auto-retried: a second attempt from the same IP is the same answer with a
   worse reputation. A page the reader cannot recognise still says "unclear", because
   guessing a submission worked is worse than admitting we cannot read it.
9. **A host that cannot read the CRM never blames the applicant for it.** The CRM
   connector (`PGHOST`/`PGUSER`/`PGPASSWORD`/`PGDATABASE`) is a **per-host** setting —
   it is not carried by the shared database. On a host without it, an incoming AWL-ID
   becomes a nameless placeholder (empty email/phone/resume) because the lookup is
   never attempted, and the apply then dies saying "Resume unavailable: no resume
   address" even though `public.client_profiles` has the whole person, resume link
   included. That is what happened to AWL-25663 on Railway. `core/applicant-source.js`
   now splits that one message into its four real owners — *no connector here*,
   *the CRM read failed*, *no row for this AWL-ID*, *row exists but has no resume* —
   and the first two are host faults: the application is handed back to the queue for a
   capable host (`run_deferred_no_crm`) instead of being recorded as the applicant's
   FAILED. Ingest also logs `connector_configured` with every placeholder and the dashboard
   shouts **"THIS HOST HAS NO CRM CONNECTOR"** instead of a quiet "created", so the
   misconfiguration is visible the moment it costs you an applicant.
   **Set the PG variables on every host that ingests or applies** — and note which
   names count, because there is now exactly one list (`core/applicant-source.js`,
   read by the pool builder itself): `PGHOST` (+`PGUSER`/`PGPASSWORD`/`PGDATABASE`)
   **or one CRM-named URL** — `PG_CONNECTION_STRING`, `AZURE_PG_URL`, `AZURE_DB_URL`,
   `CRM_DB_URL`, `CRM_DATABASE_URL`. `DATABASE_URL`/`POSTGRES_URL` are deliberately
   **not** read: on Railway/Supabase those are the *platform's own* database, and
   pointing the CRM there fails with `relation "client_profiles" does not exist`
   while looking configured. The DEV → *Applicant DB connector* card prints the
   answering host, the names it looks for and the ones that actually arrived
   (names only, never values) — check that page instead of guessing whether your
   variables reached the container.

**So where do applies run?** On any host that can launch a browser. Your own
machine opens a real window (`npm start`, worker enabled); a Railway container
submits **headlessly**, because it has no display and the rule above says so —
no variable has to be set, and a rebuild cannot lose the setting. Both hosts poll
the **same** queue, so whichever is free takes the row.

**Headless from a datacenter IP is the one thing that has cost real submissions.**
When Railway first applied, one poll tick launched three browsers in the same second
and Ashby flagged two of the three as possible spam (the third went through). The
stealth wiring hides `navigator.webdriver` and the UA; it does not hide the IP, and
three simultaneous identical submissions from one address is the shape the filter
reports on. Starts are staggered on every host now (`RUN_START_SPACING_MS`, default
1500ms — previously this pacing was switched off exactly when it was needed), but no
spacing makes a datacenter look residential: where deliverability matters more than
throughput, set `WORKER_ENABLED=false` on the container and let the laptop take
applies, or `APPLY_HEADLESS=false` with a real display/xvfb on a server. Either way a
host that cannot produce the mode it asked for measures itself as **unable to apply**
and leaves QUEUED rows alone instead of faking a READY.

**Build command** (`railway.json`) is now:

```bash
npm install && npm install --prefix ashbyhq-dashboard && npm run browser:install
```

`scripts/ensure-browser.js` is idempotent and never fails the build — a host it
cannot equip is pinned off by the gate with the reason in the DEV pane, which is
better than a deploy that does not start. Skip it with
`APPLYWIZZ_SKIP_BROWSER_INSTALL=true` when the image already has a browser.

**The org chart is real now, and read-only from the CRM.** A CA signing in sees
their own AWL-IDs **and** which OM(CAM) they report to; an OM sees only the CAs
under them and those CAs' clients. Identity (name/email/role) comes from the
committed roster in `connector/staff-roster.js` (59 CAs + balaji/RK as OPS +
two admins) because the four permitted CRM tables carry only CA/OM *UUIDs*,
never a name. The CA→OM edge and each applicant's `ca_id`/`ops_id` are derived
live from `clients_additional_info`'s `career_associate_id` /
`career_associate_manager_id`, matched onto staff by `ext_id` — a reporting line
is never invented. `seedStaffDirectory()` is idempotent (keyed on `ext_id`,
emails stored lower-case) and fires on boot + full sync. When the CRM
re-attaches an applicant to a different CA than a placeholder first guessed
(AWL-25663 → Manusha Nune under balaji), her **live** applications re-point to
the real CA but any SUCCESS row stays as history. Now that the real roster is
in, the `@applywizz.local` fixtures are **purged, not merely retired**:
`connector/staff-purge.js` keeps only staff whose email domain is exactly
`@applywizz.com` / `@applywizz.ai` (the two real ADMINs included), first
re-points any applicant a fixture still owns onto its real CRM CA (live apps
follow, SUCCESS stays history), then **deletes** a fixture that owns nothing and
**retires** (`active=0`) one still pinned by unresolvable work or history, so no
FK can ever break. Run it from the ADMIN Staff tab's confirm-gated *Fixture
cleanup* (preview → tick → apply), `POST /api/dev/staff/purge` (dry-run unless
`apply:true`), or `node scripts/purge-local-staff.js --apply`; `npm run seed`
now seeds the real tree and purges, so a fresh checkout never re-creates a
fixture. Sign-up
only ever mints a brand-new person, and only as **CA, OM or DEV** — the pick
is mandatory (`assertSignupRole` in `server.js` rejects an empty/invented role
with 400 and ADMIN with 403; the grandfathered `@applywizz.com/.ai` emails of
the 59 CAs and the admins can never self-mint and are pointed at *Sign in*).
ADMIN exists only for the rostered admins and via promotion from the Staff tab
(`/api/admin/staff/:uuid/role`). The DEV
pane reads it at *Staff tree* (`/api/dev/staff/tree`) with a live
`staffDirectoryStats()`. If the CRM names a CA outside the roster it is shown
as `tree_unresolved` — that applicant gets its OM but no CA until you add the
person to the roster. **Client info is fetched only by the Applicant DB
connector** (`connector/applicant-db.js`, pool from `azure-config.js`)
— staff-directory.js reads just the CA/OM edge columns.

**The OM + DEV snapshot view.** In the OPS *CA view* tab and the DEV *People*
tab, drilling into a CA now lists every one of their job links **with the run's
pre-submit + acknowledgement screenshots**, and clicking a client's AWL-ID
narrows the list to just that client's applications with their snaps + link
attached. An OM sees only the CAs under them (the endpoint refuses a CA outside
their `manager_id`), how many applications each CA made, and for which clients
— then opens any client to see that evidence.

**Applicant limits are per-CA, and the OM owns them.** The cap no longer sits on
the OPS manager — it lives on each Career Associate (`staff.applicant_quota`,
**default 25**). An OM sets every one of their CAs' limits straight from the OPS
*Overview* table, and DEV/ADMIN can set any CA from *Data Sync → Per-CA applicant
quota*. A new assignment is refused only when *that CA* is full (the dropdown
greys out a full CA), so an OM is never frozen out by a number DEV picked. Re-
attaching an applicant already on the CA does not double-count, and DEV/ADMIN may
still exceed a limit to rebalance.

**Why a field shows "Needs your input" instead of pre-filling.** A box is
auto-filled *deterministically* only when a hand-written rule recognises its
wording **and** the value is on the applicant's record. Everything else falls
to the semantic mapper / GenAI — so when GenAI is out of credit (HTTP 429) those
fields strand as "needs input" even when the CRM has the data. Phone Number hit
exactly this: the number was stored (`contact.phone`) but the old rule only
matched the bare label "Phone", so "Phone Number" never filled. The rule now
covers its common spellings (Phone Number, Primary/Mobile/Cell/Contact Number,
WhatsApp…) and reads the number straight from the record with no API call, while
still refusing unrelated "…Number" boxes.

**The resume is mined before the CA is ever asked.** Now that the CRM record has
had its chance (Tiers 1–2.5), an email / phone / link question that the record
could not answer is read straight out of the **applicant's own resume** by a
model-free shape match (`draft-service.js: resumeShapeAnswer`) — so it keeps
working while GenAI is quota-exhausted, and a value we genuinely hold is never
dumped on a CA. It is deliberately narrow: only a clean email/phone/URL hit from
the resume fills, anything ambiguous still goes to the CA, so nothing is invented.
Alongside it, `placeholderFor` will **never** type "N/A" into a URL / link /
portfolio / LinkedIn box again — "N/A" is not a valid URL and Ashby rejects it
with "Please enter a valid URL", which is exactly what failed a real submission.
A link field with nothing to source stays blank for the CA rather than being
poisoned with a placeholder.

**The worker idles when there is nothing to do, and never hangs.** An empty queue
already launches nothing (the poll tick claims zero rows and returns). The one
real gap was a run that never returned: it would hold a browser slot forever.
A `RUN_TIMEOUT_MS` watchdog (default 6 min, `worker/runner.js`) now SIGKILLs a
child that outlives it, so `finish()` runs, the slot is freed, and the worker goes
idle — a stuck or empty queue can never keep a machine busy. After both evidence
shots the engine exits on its own; the watchdog is a brake on a hung child, not a
cap on a normal run.

**On the pre-submit screenshot not tiling the whole page.** Both evidence shots
are taken by the base engine (`ashby-hybrid-automation.js`, `page.screenshot({
fullPage: true })`), which is never edited. On Ashby's form a sticky header
re-paints while Chromium scrolls-and-stitches the tall page, so the logo can
overlap mid-page. This is cosmetic only — it is a review artefact, not what the
form submits, and not the reason a submission failed. Fixing the stitching would
mean editing the engine, which is off-limits, so it is flagged here rather than
patched.

**A closed / removed posting is proven, not retried.** When a listed link now
renders Ashby's "Job not found" / "This posting has expired" page, that is a
*terminal fact about the link*, not a scan error. `core/scan-verdict.js` names it
`posting_gone` (before the generic "no fields" case), and `scripts/scan-link.js`
captures a **full-page proof screenshot** (`core/page-evidence.js`, headless,
best-effort — a capture or Storage failure never becomes a scan error), uploads it
to Supabase Storage, and records it on the link row (`link_status='unavailable'` +
`link_evidence_json`). The scan worker treats it as DONE (never retried, no draft
pre-warm), the link leaves the unscanned backlog, and **the assigned CA sees the
proof as a small thumbnail on the queue card itself** (below the action buttons,
same style as the run's acknowledgement image — not a big image inside "Review
answers"), with APPLY locked and the page's own words as the reason — so nobody
has to open the URL to learn why there is nothing to fill.

**Before shipping**, from the repo root:

```bash
npm run verify:flow   # 223 assertions: gate per mode, defer/refund, hand-back +
                      # park, cache provenance, junk refusal, publish path, workers,
                      # resume-source attribution, one CRM name list, idempotent
                      # staff-directory seed + CA/OM sign-in scoping + per-CA limits
                      # + record-backed identity fields (phone) with no GenAI, the
                      # URL-placeholder guard, the model-free resume fallback and the
                      # hung-run watchdog, the fixture purge (delete vs retire), the
                      # sign-up role gate (CA/OM/DEV only, never ADMIN), the dead
                      # @applywizz.local domain (fully removed + refused as invalid
                      # mail) and the CA work-history (dynamic DEV/ADMIN-only external
                      # APIs with no hardcoded host, the ca_data AWL->CA->OM bridge,
                      # visibility-only assignment that never auto-queues, and the
                      # cached work-history span + per-link detail fallback)
```

---

*Ready to start your Ashbyhq automation research!*