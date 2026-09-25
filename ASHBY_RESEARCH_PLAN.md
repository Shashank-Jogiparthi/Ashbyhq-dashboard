# ApplyWizz × Ashby — Production Workflow & Data Model

> Living reference for how an applicant goes from the CRM to a submitted Ashby
> application, which file does what, and exactly how Supabase stores every piece
> of it — including how **you** add or remove columns/rows/fields.
>
> **Naming note:** the role formerly called **CAM ("Client/Career Associate
> Manager")** is now **OPS — "Operational Manager"**. The value in the database
> is `'ops'`, the column is `applicants.ops_id`, the routes are `/api/ops/*`.
> `CA` still means **Career Associate** (the person who reviews and applies).
> The external CRM column is still literally `career_associate_manager_id`
> (it lives in Azure, we only *read* it) — it maps to our `ops` staff `ext_id`.

---

## 1. Roles & access

| Role | Dashboard | Sees / can do |
|------|-----------|---------------|
| `ca` | My Applicants, My Activity | Reviews the pre-filled answers for each assigned job link, edits them, then APPLY / SKIP. |
| `ops` | Overview, Assignments, CA Overview, Applicants, Job Links, Applications, Activity | Owns an applicant pool (quota-capped), assigns applicants to their CAs, per-link reassign / force-status overrides. |
| `dev` | System, Data Sync, Queue, Applicants, Applications, Staff, People, Events, Raw Tables | Triggers CRM sync, ingests docs, sets quotas, enables the worker, inspects raw tables/events. |
| `admin` | (all of DEV) + role change + member removal | Full org control. |

Sign-in is email + a 6-digit OTP (`core/mailer.js` logs the code to the server
console in local mode). Roles are fixed at first sign-up; the login dropdown only
picks the OPS a brand-new CA reports to.

---

## 2. End-to-end workflow

This is the path you asked to be airtight: **what a CA edits is what gets
filled, what gets finalized, and what is stored.**

1. **Applicants arrive from Azure CRM → Supabase.**
   `connector/applicant-db.js` joins `public.client_profiles` +
   `public.clients_additional_info` on the **AWL-ID** (`applywizz_id`),
   normalises them into one `profile_json`, and upserts `applicants`. The resume
   is stored only as its **S3 address** (`resume_address`), never the file.

2. **Job links arrive from `public.clients_legacy`.**
   On every sync, `syncLinksFromClientsLegacy()` reads the AWL→link table (see
   §5) and writes each (AWL-ID → URL) into `applicant_joblinks` as *pending*.
   If that table does not exist yet, the sync just logs `legacy_links_status`
   and continues — so you can start dropping links in whenever you like.

3. **OPS assigns an applicant to a CA** (`POST /api/ops/assign`). The pending
   links *materialise* into real `applications` rows (status `ASSIGNED`), one per
   link, owned by that CA and their OPS manager.

4. **CA reviews / edits the answers** in the queue card. The first time it opens,
   a draft pass runs (`draft-service.js` → deterministic fill from `profile.raw`,
   GenAI only for descriptive questions) and lands in
   `applicant_field_answers`. **Every edit the CA makes is persisted immediately**
   via `POST /api/applications/:id/answers/edit` → `applyCaEdits()`, which stamps
   that row `source='ca_edited'` and locks it. APPLY stays disabled until there
   are zero blockers (every required field answered).

5. **CA clicks APPLY** (`POST /api/applications/:id/apply`): the row → `QUEUED`
   and the worker is kicked.

6. **The worker runs the application.** `worker/runner.js` launches the proven
   Playwright engine (`ashby-hybrid-automation.js`) as an isolated child process
   with **its own OS-temp working directory**, and hands it:
   - the applicant `profile_json`,
   - the downloaded resume (into the temp dir, deleted after),
   - and **the exact finalized `applicant_field_answers`** via
     `FIELD_ANSWERS_PATH`, so the engine *replays the CA's confirmed answers onto
     the live form* rather than re-guessing.

7. **Outcome is stored in Supabase** (`applications` + `automation_runs`):
   - `SUCCESS` — submitted and acknowledged;
   - `FAILED` — validation banner captured as a **text reason**;
   - `PENDING` — submitted but acknowledgement unclear / manual review;
   - `FAILED + missing fields` → the run re-opens to `ASSIGNED` and the still-
     blank questions are surfaced back to the CA as blockers (`source='missing_fact'`),
     so the next APPLY cannot proceed until they are answered (the re-loop).

7b. **Two evidence screenshots per applicant × job-link are captured** by the
   engine and uploaded to **Supabase Storage**:
   - **#1 `pre-submit`** — the fully-filled form, after every entry field is
     populated and **before** the "Submit Application" button is clicked;
   - **#2 `acknowledgement`** — the post-submit confirmation / validation banner
     (the shot that already existed).
   The runner (`worker/runner.js` → `persistScreenshots`) uploads both PNGs from
   the temp dir via `connector/supabase-storage.js`, stores their **public URLs**
   in `applications.screenshot_path` (acknowledgement) and
   `applications.screenshots_json` (`{ pre_submit, acknowledgement }`), then
   deletes the temp files. If Storage is not configured it records the reason in
   `screenshots_json.error` instead of an image — **the PNG never stays local**.
   The CA sees both as clickable thumbnails on the application's queue card.

8. **On SUCCESS only, the finalized details are written back to the CRM.**
   `persistFinalizedToExternal()` (connector, called by the runner) mirrors the
   applied record — AWL-ID, job URL, company/title, the confirmed answers, and
   the profile (minus the heavy `raw` blob) — into the Azure table
   `public.applywizz_applications`. This is **best-effort**: it is auto-created
   if missing and every error is swallowed, so it can never flip a run's status.
   A failure is **never** written back (a missing-field failure produces a reason,
   not a CRM record).

9. **Nothing applicant-related stays on disk** — see §6.

---

## 3. File catalogue — what each file is and its part in the workflow

### Base automation layer — repo root `AshByHq/`

| File | Contains | Role in workflow |
|------|----------|------------------|
| `ashby-hybrid-automation.js` | The Playwright engine (919 ln). Opens the job link, fills + submits, detects the outcome, writes a job-status JSON into its temp `APPLICANT_DATA_DIR`. | Step 6 — the child process the worker spawns per application. Replays `FIELD_ANSWERS_PATH`. |
| `field-applier.js` | Maps a resolved answer onto a concrete DOM control (radio/combobox/checkbox/text). | Engine internals — how a CA answer actually lands in the field. |
| `genai-resume-filler.js` | GenAI answer drafting for free-text / descriptive questions. | Used by the draft pass (step 4) and the engine fallback. |
| `parse-resume.js` | Resume PDF → structured profile. | Enriches `applicants.parsed_profile_json`. |
| `humanize.js` | Typing/pacing helpers to look human. | Engine anti-detection. |
| `applicant-profile-store.js` | Reads/writes the per-applicant working profile. Default location is now the **OS temp dir** (`APPLICANT_DATA_DIR`), never the repo. | Keeps transient run files out of the tree. |
| `ashby-test-script.js` | Standalone manual test harness. | Dev/testing only. |

### Dashboard / platform — `ashbyhq-dashboard/`

| File | Contains | Role in workflow |
|------|----------|------------------|
| `server.js` | Express app: auth (OTP), and all `/api/{ca,ops,dev,applications,public}/*` routes; boots the DB, seeds admin, starts the worker. | HTTP surface for every step. |
| `db/index.js` | **Dual-backend** data layer (Supabase Postgres ⇄ local SQLite), the `db.prepare(sql)` adapter, `migrate()`, and the idempotent `migrateCamToOps{Postgres,Sqlite}()`. On Supabase the CAM→OPS rename runs **before** the schema file, so the `idx_applicants_ops` index is never built against a missing `ops_id`. | Chooses storage, creates/repairs the schema on every boot. |
| `db/store.js` | ~Every data operation (943 ln): staff, applicants, job links, applications, `applicant_field_answers` (`listFieldAnswers`, `applyCaEdits`, `recordSubmitMissingFields`, `reopenForMissingFields`), events, system state. | The single source of truth the API + worker call. Backend-agnostic SQL. |
| `db/schema.supabase.sql` | Hosted table definitions (Postgres 15+). | Reference for §4; applied on boot. |
| `db/schema.sql` | Local SQLite mirror of the same tables. | Dev fallback. |
| `connector/applicant-db.js` | Azure CRM reader: `syncFromPostgres`, `mapCombined`, `syncLinksFromClientsLegacy` (`clients_legacy`), `persistFinalizedToExternal` (write-back). `pg` imported lazily. | Steps 1, 2, 8. |
| `connector/supabase-storage.js` | Uploads the two run PNGs to Supabase Storage via the REST API (`fetch`, no extra dep); returns public URLs, degrades to a reason when unconfigured. | Step 7b — screenshot persistence. |
| `draft-service.js` | `runDraftPass` — deterministic + GenAI first-pass answers before the CA reviews. | Step 4 (drafting). |
| `worker/runner.js` | Parallel runner: claims `QUEUED`, spawns the engine in a **temp dir**, maps outcome → status, re-loops on missing fields, and calls the write-back on success. | Steps 6–9. |
| `core/mailer.js` | OTP code delivery (console in dev). | Sign-in. |
| `public/index.html` + `public/js/auth.js` | Login screen; role + OPS picker. | Entry. |
| `public/dashboard.html` + `public/js/app.js` + `public/css/style.css` | The whole SPA: CA review/edit pane, OPS assignment/links/overrides, DEV sync/queue/raw tables. | Every UI step. |
| `scripts/seed.js` | Ensures staff sign-in accounts exist (idempotent; no fake applicants). | Provisioning. |
| `scripts/init-supabase.js` | Applies `schema.supabase.sql` to the hosted DB. | One-time / repair setup. |
| `scripts/setup-storage.js` | Creates the **Supabase Storage** bucket (`application-screenshots`, public read) + its read policy over the existing `SUPA_DB_URL` connection — no API key needed. Run with `npm run setup:storage`. | Step 7b — one-time screenshot storage setup. |
| `scripts/scan-link.js` | Pre-scans a job link into `job_link_fields`. | Step 4 prerequisite. |
| `scripts/draft-answers.js` | CLI to run the draft pass for one applicant×link. | Debugging step 4. |

---

## 4. Supabase data model (hosted Postgres)

**`db/index.js` decides the backend:** if `SUPA_DB_URL` (or `SUPA_HOST/USER/PASSWORD`)
is set it uses Supabase Postgres; otherwise a local `data/app.db` SQLite. Both run
the **same SQL** from `db/store.js` — the adapter rewrites `?` placeholders to `$n`
and registers Postgres type-parsers so `int8/numeric → Number` and
`json/jsonb/date/time → raw TEXT`. That is why `store.js` can keep doing
`JSON.parse` / reading ISO strings identically on both backends.

### Tables and their columns

- **`staff`** — who can log in.
  `uuid` PK · `email` UNIQUE · `name` · `role` CHECK IN
  (`ca`,`ops`,`dev`,`admin`) · `manager_id`→staff (a CA's OPS) ·
  `applicant_quota` (per-OPS cap, default 25) · `ext_id` (CRM staff uuid) ·
  `active` (0/1) · `last_sign_in` · `created_at`.

- **`applicants`** — the CRM snapshot, keyed **only** by `awl_id` PK.
  `full_name` · `email` · `phone` · `am_id`→ams · `ca_id`→staff (assigned by OPS) ·
  `ops_id`→staff (owning OPS) · `ext_id` (CRM uuid) · `assigned_at` ·
  `resume_address` (S3 https; downloaded per run, never stored) ·
  `profile_json` JSONB (`{personal,contact,education,skills,experience,answers,raw:{client,additional_information}}`) ·
  `parsed_profile_json` JSONB · `source_updated_at` · `crm_updated_at` (watermark).

- **`ams`** — account managers. `uuid` PK · `name` · `email`.

- **`job_links`** — one row per unique Ashby URL. `id` identity PK ·
  `company` · `title` · `url` UNIQUE · `url_hash` · `link_status`
  (valid/expired/already_applied) · `scan_status` (unscanned/scanned) ·
  `scanned_at` · `seeded_at`.

- **`job_link_fields`** — the question inventory, scanned **once per link**.
  `id` PK · `link_id`→job_links · `field_key` (normalised id used to match an
  answer back to a control) · `question_text` · `question_summary` (short GenAI
  gist) · `field_type`
  (`text|textarea|select|radio|checkbox|combobox`) · `options_json` JSONB ·
  `answered` · `needs_genai` · `sort_order` · `scanned_at` ·
  UNIQUE(`link_id`,`field_key`).

- **`applicant_joblinks`** — pending (AWL→URL) pairs from `clients_legacy`,
  queued to become applications on assignment. `id` PK · `awl_id`→applicants ·
  `url` · `company` · `title` · `materialized` (0/1) · `added_at`.

- **`applications`** — one applicant × one link (the lifecycle object).
  `id` PK · `awl_id`→applicants · `link_id`→job_links · `ca_id`→staff ·
  `manager_id`→staff · `status` (ASSIGNED|QUEUED|APPLYING|SUCCESS|PENDING|FAILED) ·
  `skip_reason` · `fail_reason` · `run_id` · `attempts` · `screenshot_path` (ack URL) ·
  `screenshots_json` JSONB (`{ pre_submit, acknowledgement, error? }`) ·
  `resolution_log_json` JSONB · `decision_by` · `decision_at` · `queued_at` ·
  `finished_at` · `created_at` · `updated_at` · UNIQUE(`awl_id`,`link_id`).
  *(A partial index on `queued_at WHERE status='QUEUED'` keeps the worker poll fast.)*

- **`applicant_field_answers`** — **the finalized-answers store.** This is what
  makes a run fast and what guarantees "CA edit == what gets applied".
  `id` PK · `awl_id`→applicants · `link_id`→job_links · `field_key` ·
  `question_text` · `field_type` · `options_json` JSONB · `value` (NULL until answered) ·
  `source` (`deterministic|genai|missing_fact|ca_edited|placeholder`) ·
  `evidence_json` JSONB · `optional` (0/1) · `sort_order` · `drafted_at` ·
  `updated_at` · UNIQUE(`awl_id`,`link_id`,`field_key`).

- **`application_events`** — append-only audit trail. `id` PK ·
  `application_id` · `type` (e.g. `run_started`,`run_success`,`ops_assigned_ca`,
  `crm_writeback`) · `actor` · `payload_json` JSONB · `ts`.

- **`automation_runs`** — execution history (needed for parallel runs). `id` PK ·
  `run_id` UNIQUE · `application_id` · `awl_id` · `link_id` · `status`
  (running|success|pending|failed|spam_blocked|crash) · `reason` ·
  `screenshot_path` · `screenshots_json` JSONB · `started_at` · `finished_at` · `duration_ms` · `attempts`.

- **`otp_codes`** (`email` PK, `code`, `expires_at`, `attempts`, `created_at`) and
  **`sessions`** (`token` PK, `staff_uuid`→staff, `created_at`, `expires_at`) — auth.

- **`system_state`** (`key` PK, `value`, `updated_at`) — flags like
  `worker_enabled`.

---

## 5. `public.clients_legacy` (your job-link source)

This is the table you'll drop AWL→link pairs into. `connector` reads it on every
sync via **runtime introspection** (`information_schema.columns`), so the *exact*
column names are matched, not hard-coded:

- **AWL column** — any of `applywizz_id, awl_id, awl, client_id, applywizz`
  (else the first column whose name contains `applywizz`).
- **URL column** — any of `job_link, job_url, url, link` (else first with
  `link`/`url`).
- Optional **company** (`company`,`company_name`,`organization`) and
  **title** (`title`,`job_title`,`role`,`position`).

Override the table name with `PG_LINKS_TABLE` (default `public.clients_legacy`).
If the table/columns are missing, the sync records
`summary.legacy_links_status = table_missing | columns_unrecognised` and skips
without failing. Each accepted row becomes an `applicant_joblinks` pending link.

**Write-back target:** successful applications are mirrored into
`public.applywizz_applications` (`awl_id`,`job_url`,`company`,`title`,`status`,
`applied_at`,`profile_json`,`answers_json`,`resume_address`; PK
`awl_id,job_url`). Override with `PG_RESULT_TABLE`; disable entirely with
`PG_WRITEBACK=false`. It is `CREATE TABLE IF NOT EXISTS`-guarded and best-effort.

---

## 6. No local records (privacy policy)

- The worker runs each attempt in `os.tmpdir()/applywizz-runs/<runId>` and
  `rmSync` deletes the **entire** directory the moment the run finishes —
  profile, answers, downloaded resume, engine job-status JSON, and any
  screenshots. Nothing applicant-related is written into the repo.
- `applicant-profile-store.js` defaults to the OS temp dir too
  (overridable with `APPLICANT_DATA_DIR`).
- **Screenshots are never kept locally.** The two evidence PNGs are uploaded to
  **Supabase Storage** and only their **public URLs** are saved
  (`applications.screenshot_path` + `applications.screenshots_json`). If Storage
  is not configured (`SUPA_PROJECT_URL` / `SUPA_SERVICE_KEY` missing, or the
  upload fails), the **reason is stored instead**
  (`screenshots_json.error`) — the image itself is never written into the repo.
- `.gitignore` blocks `applicant-data/`, `data/runs/`, `*.pdf`, `.env`, and the
  old screenshot/result folders.

---

## 7. Adding / removing fields, columns, rows (your guide)

Supabase is just Postgres. You can work in the **Table Editor**, **SQL Editor**,
or straight through the **DEV → Raw Tables** dashboard tab. The safe recipe:

### Add a column to a table
1. Supabase **SQL Editor**:
   `ALTER TABLE public.applicants ADD COLUMN linkedin_url text;`
2. Add the same line to `db/schema.supabase.sql` (and the SQLite equivalent
   `ALTER TABLE applicants ADD COLUMN linkedin_url TEXT;` in `db/schema.sql`, or a
   new `ensureColumnSqlite('applicants','linkedin_url','TEXT')` call in
   `db/index.js migrate()`), so a fresh boot reproduces it.
3. Use it in `db/store.js` queries. Placeholders stay `?`.

### Remove a column
`ALTER TABLE public.<t> DROP COLUMN <c>;` — then delete its references in the two
schema files and any `store.js` INSERT/UPDATE that lists it. (Dropping is
irreversible; prefer leaving it unused if unsure.)

### Add / remove a whole table
Add the `CREATE TABLE ...` to `db/schema.supabase.sql` (hosted) and `db/schema.sql`
(SQLite), plus a `db.prepare` accessor in `store.js` and a route in `server.js`.
Remove with `DROP TABLE public.<t>;` and delete the corresponding code + the table
name from the raw-table allow-list in `store.js`.

### Edit rows / values by hand
Supabase **Table Editor → the table → double-click a cell** (or
`UPDATE public.applicants SET full_name='X' WHERE awl_id='AWL-123';`). Deletes:
**Row … → Delete** (or `DELETE FROM ...`).

**Cautions**
- `role` is constrained to `ca/ops/dev/admin` (`staff_role_check`). To add a role,
  `ALTER TABLE staff DROP CONSTRAINT staff_role_check;` then re-add with the new
  value, and update `VALID_ROLES` in `server.js` + the role arrays in `store.js`
  and the UI.
- Flag columns are `SMALLINT 0/1` (not boolean) on purpose — keep them 0/1 so the
  shared SQL keeps working on SQLite.
- `*_json` columns are JSONB but read back as **text** at runtime — always
  `JSON.parse` them in `store.js` (do not switch to boolean/Date).
- The `migrateCamToOps*` steps in `db/index.js` are guarded and idempotent; you can
  leave them in forever or delete them once you're sure no old `cam`/`cam_id`
  shape remains.

---

## 8. Configuration reference (`.env`)

| Key | Meaning |
|-----|---------|
| `SUPA_DB_URL` *or* `SUPA_HOST/SUPA_PORT/SUPA_USER/SUPA_PASSWORD/SUPA_DATABASE/SUPA_SSL` | Enables the hosted Supabase backend (otherwise local SQLite). |
| `DB_BACKEND` | Force `sqlite` or `supabase`. |
| `PGHOST`/`AZURE_PG_HOST`, `PGUSER`, `PGPASSWORD`, `PGDATABASE`, `PGPORT`, `PGSSL`, or `PG_CONNECTION_STRING` | The **Azure CRM** connection (separate from Supabase). |
| `PG_APPLICANTS_TABLE` / `PG_APPLICANT_INFO_TABLE` | CRM profile/info tables (defaults `public.client_profiles` / `public.clients_additional_info`). |
| `PG_LINKS_TABLE` | Legacy job-link table (default `public.clients_legacy`). |
| `PG_RESULT_TABLE` | Write-back target (default `public.applywizz_applications`). |
| `PG_WRITEBACK` | `false` disables CRM write-back. |
| `ENGINE_PATH` | Path to `ashby-hybrid-automation.js`. |
| `MAX_CONCURRENT_RUNS` / `WORKER_POLL_MS` | Worker parallelism / poll interval. |
| `RUN_TMP_DIR` / `APPLICANT_DATA_DIR` | Override the OS-temp working dirs. |
| `SUPA_PROJECT_URL` + `SUPA_SERVICE_KEY` (or `SUPA_STORAGE_KEY`) | Enables **Supabase Storage** upload of the two run screenshots. Without both, screenshot URLs are skipped and the reason is stored instead. |
| `SUPA_SCREENSHOT_BUCKET` | Storage bucket for screenshots (default `application-screenshots`; created once by `npm run setup:storage`). |
| `SUPA_TLS_INSECURE` | `true` relaxes TLS verification for the direct Supabase endpoint (`db.<ref>.supabase.co` serves a private-CA certificate). Needed by `scripts/setup-storage.js`; the pool in `db/index.js` already behaves this way. |

### Where and how to run it

All commands run from the **dashboard folder** (it owns `package.json` + `node_modules`):

```powershell
cd C:\Users\jogip\Downloads\AshByHq\ashbyhq-dashboard

npm run setup:storage   # one-time: creates the screenshot bucket (already done)
npm start               # = node server.js  (migrate + API + worker on http://localhost:3100)
npm run dev             # same, auto-restart on file changes
node scripts/setup-storage.js   # equivalent, bypasses npm if npm.ps1 misbehaves
```

In PowerShell chain commands with `;` (never `&&`). To run against Supabase while a
stale `DB_BACKEND=sqlite` lingers in your shell: `Remove-Item Env:DB_BACKEND`.

---

## 9. Verification status

- `node --check` passes on every touched file (connector, runner, store,
  db/index, server, app.js, auth.js, setup-storage.js).
- Server boots **against the live Supabase project**: `migrate: promoted 2 staff
  row(s) role cam -> ops`, then `Database ready: Supabase Postgres (SUPA_DB_URL)`.
  `GET /api/public/ops` → `200`, the legacy `GET /api/cam/*` route → `404`
  (rename complete).
- The `ops_id` boot crash is fixed: `migrateCamToOpsPostgres()` now runs **before**
  `execSql(schema.supabase.sql)` and self-skips on a fresh DB, so the schema's
  `idx_applicants_ops` index always finds the renamed column.
- Storage: the `application-screenshots` bucket exists with `public=true` and a
  public-read policy (verified via `npm run setup:storage`). Screenshot upload still
  needs `SUPA_SERVICE_KEY` in `.env`; until then runs record
  `storage_not_configured` instead of URLs.
- All previously stored local applicant records under `data/runs/` and
  `applicant-data/` have been purged.
