-- =====================================================================
-- ApplyWizz HOSTED SCHEMA  (Supabase Postgres / PostgreSQL 15+)
-- ---------------------------------------------------------------------
-- This is the Supabase port of db/schema.sql (local SQLite). It is the
-- shared WORKING CACHE the multi-user app runs on: the CRM (Azure
-- Postgres) is the upstream source, synced per applicant BY AWL-ID on
-- demand; everything the automation reads at run time lives here.
--
--   * applicant snapshot ......... applicants          (never re-fetch CRM)
--   * pre-scan: questions+types .. job_link_fields     (once per unique link)
--   * per-applicant answers ...... applicant_field_answers (ordered by sort_order)
--   * lifecycle .................. applications / application_events
--   * execution history ......... automation_runs     (NEW, for hosting)
--
-- Differences from the SQLite schema, on purpose:
--   - surrogate ids are INT GENERATED ALWAYS AS IDENTITY.
--   - *_json columns are JSONB (queryable/indexed server-side), but the
--     runtime registers a raw-text type parser for JSONB so rows still
--     arrive as strings and the store's JSON.parse/JSON.stringify call
--     sites work UNCHANGED in both backends.
--   - flag columns stay SMALLINT 0/1 (NOT boolean): the application writes
--     `active: 1`, `optional ? 1 : 0` and filters `materialized = 0`, so 0/1
--     keeps one identical contract across SQLite and Postgres.
--   - applications gains UNIQUE(awl_id, link_id) (idempotency at scale).
--   - timestamp columns stay TEXT (ISO-8601) so the thin adapter keeps
--     passing/reading ISO strings exactly like the local store does.
--   - resumes are NOT stored: applicants.resume_url holds the S3 link the
--     worker downloads per run. (Mirror to Supabase Storage later if desired.)
--
-- Apply with the service/`postgres` role (RLS not enabled here; add
-- policies before exposing the project through PostgREST/the JS client).
-- =====================================================================

-- ---- identity / staffing / auth -------------------------------------
CREATE TABLE IF NOT EXISTS staff (
  uuid            TEXT PRIMARY KEY,
  email           TEXT NOT NULL UNIQUE,
  name            TEXT NOT NULL,
  role            TEXT NOT NULL CHECK (role IN ('ca','ops','dev','admin')),
  manager_id      TEXT REFERENCES staff(uuid),          -- CA's OPS manager; NULL otherwise
  applicant_quota INTEGER NOT NULL DEFAULT 25,          -- per-OPS cap
  ext_id          TEXT,                                 -- external CRM staff uuid
  active          SMALLINT NOT NULL DEFAULT 1,
  last_sign_in    TEXT,
  created_at      TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ams (
  uuid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS otp_codes (
  email      TEXT PRIMARY KEY,
  code       TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts   INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token        TEXT PRIMARY KEY,
  staff_uuid   TEXT NOT NULL REFERENCES staff(uuid) ON DELETE CASCADE,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL
);

-- ---- job links (unique per normalised URL) + scanned fields ---------
CREATE TABLE IF NOT EXISTS job_links (
  id          INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  company     TEXT NOT NULL,
  title       TEXT NOT NULL,
  url         TEXT NOT NULL UNIQUE,
  url_hash    TEXT NOT NULL,
  link_status TEXT NOT NULL DEFAULT 'valid',            -- valid | expired | already_applied
  scan_status TEXT NOT NULL DEFAULT 'unscanned',        -- unscanned | scanned
  scanned_at  TEXT,
  seeded_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_job_links_url_hash ON job_links(url_hash);

-- Pre-automation scan: the question inventory (text + control type +
-- options) captured ONCE per unique link and reused for every applicant.
-- field_key is the normalised question used to match a stored answer back
-- to the same control across re-runs.
CREATE TABLE IF NOT EXISTS job_link_fields (
  id            INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  link_id       INT NOT NULL REFERENCES job_links(id) ON DELETE CASCADE,
  field_key     TEXT NOT NULL,
  question_text TEXT NOT NULL,
  question_summary TEXT,                                -- short GenAI gist for long questions
  field_type    TEXT NOT NULL,                           -- text|textarea|select|radio|checkbox|combobox
  options_json  JSONB NOT NULL DEFAULT '[]'::jsonb,
  answered      SMALLINT NOT NULL DEFAULT 0,
  needs_genai   SMALLINT NOT NULL DEFAULT 0,
  -- Did the FORM say the question is mandatory? Read off the control/caption at
  -- scan time (label._required + "*" vs "(optional)"): 1 = required, 0 = the
  -- form called it optional, NULL = the form never said -> treated as required.
  required      SMALLINT,
  -- Which single column of the applicant record answers this question, decided 
  -- ONCE per link by the semantic mapper (see field-mapping.js) and reused for
  -- every applicant on the link: NULL = never mapped, '' = mapped and the
  -- record genuinely has nothing (essay/descriptive question), otherwise the
  -- exact record key the automation reads the value from.
  bound_key     TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  scanned_at    TEXT NOT NULL,
  UNIQUE (link_id, field_key)
);
CREATE INDEX IF NOT EXISTS idx_joblink_fields_order ON job_link_fields(link_id, sort_order);

-- ---- applicants (CRM snapshot; keyed only by AWL-ID) ---------------
-- profile_json holds the merged { personal, contact, education, answers,
-- raw:{client, additional_information} } the engine's buildRecordMap reads.
-- Column NAMES match the SQLite store verbatim (profile_json, resume_address)
-- so store.js needs no rename pass; only the storage type differs (JSONB,
-- returned as raw text by the runtime type parser).
CREATE TABLE IF NOT EXISTS applicants (
  awl_id             TEXT PRIMARY KEY,                  -- the ONE key needed
  full_name          TEXT NOT NULL,
  email              TEXT NOT NULL,
  phone              TEXT,
  am_id              TEXT REFERENCES ams(uuid),
  ca_id              TEXT REFERENCES staff(uuid),       -- set by the OPS manager
  ops_id             TEXT REFERENCES staff(uuid),       -- owning OPS pool
  ext_id             TEXT,                              -- CRM clients uuid
  assigned_at        TEXT,
  resume_address     TEXT,                              -- S3 https; downloaded per run, never stored
  profile_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
  parsed_profile_json JSONB,                            -- engine-parsed resume profile (structured, per AWL row)
  source_updated_at  TEXT,
  crm_updated_at     TEXT                               -- watermark for incremental refresh
);
CREATE INDEX IF NOT EXISTS idx_applicants_ca  ON applicants(ca_id);
CREATE INDEX IF NOT EXISTS idx_applicants_ops ON applicants(ops_id);
CREATE INDEX IF NOT EXISTS idx_applicants_email ON applicants(email);

-- (AWL-ID -> link) pairs queued to become applications on CA assignment.
CREATE TABLE IF NOT EXISTS applicant_joblinks (
  id           INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  awl_id       TEXT NOT NULL REFERENCES applicants(awl_id) ON DELETE CASCADE,
  url          TEXT NOT NULL,
  company      TEXT NOT NULL DEFAULT '',
  title        TEXT NOT NULL DEFAULT '',
  materialized SMALLINT NOT NULL DEFAULT 0,
  added_at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_joblinks_pending ON applicant_joblinks(awl_id, materialized);

-- ---- applications (per applicant x link) ---------------------------
CREATE TABLE IF NOT EXISTS applications (
  id                  INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  awl_id              TEXT NOT NULL REFERENCES applicants(awl_id) ON DELETE CASCADE,
  link_id             INT NOT NULL REFERENCES job_links(id) ON DELETE CASCADE,
  ca_id               TEXT REFERENCES staff(uuid),
  manager_id          TEXT REFERENCES staff(uuid),
  status              TEXT NOT NULL DEFAULT 'ASSIGNED',
    -- ASSIGNED | QUEUED | APPLYING | SUCCESS | PENDING | FAILED
  skip_reason         TEXT,
  fail_reason         TEXT,
  run_id              TEXT,
  attempts            INTEGER NOT NULL DEFAULT 0,
  screenshot_path     TEXT,                              -- acknowledgement image URL (Supabase Storage)
  screenshots_json    JSONB,                             -- { pre_submit, acknowledgement } public URLs
  resolution_log_json JSONB,
  decision_by         TEXT,
  decision_at         TEXT,
  queued_at           TEXT,
  finished_at         TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  purged_at           TEXT,                                -- when post-SUCCESS form data was erased
  UNIQUE (awl_id, link_id)                              -- idempotency at scale
);
CREATE INDEX IF NOT EXISTS idx_applications_ca      ON applications(ca_id, status);
CREATE INDEX IF NOT EXISTS idx_applications_manager ON applications(manager_id, status);
-- worker poll only claims QUEUED rows: partial index keeps it tiny & fast
CREATE INDEX IF NOT EXISTS idx_applications_queued
  ON applications(queued_at) WHERE status = 'QUEUED';

-- ---- per-(applicant, link) draft answer, CA-reviewed ---------------
-- This is THE cache that makes a run fast: one indexed query in
-- sort_order (the sequence the questions were scanned in) yields every
-- value ready to replay into the form — no CRM hit, no re-derivation.
--   source: deterministic | genai | missing_fact | ca_edited | placeholder
CREATE TABLE IF NOT EXISTS applicant_field_answers (
  id            INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  awl_id        TEXT NOT NULL REFERENCES applicants(awl_id) ON DELETE CASCADE,
  link_id       INT NOT NULL REFERENCES job_links(id) ON DELETE CASCADE,
  field_key     TEXT NOT NULL,
  question_text TEXT NOT NULL,
  field_type    TEXT NOT NULL,
  options_json  JSONB NOT NULL DEFAULT '[]'::jsonb,
  value         TEXT,                                   -- NULL for missing_fact awaiting CA
  source        TEXT NOT NULL,
  evidence_json JSONB NOT NULL DEFAULT '[]'::jsonb,
  optional      SMALLINT NOT NULL DEFAULT 0,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  drafted_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  UNIQUE (awl_id, link_id, field_key)
);
CREATE INDEX IF NOT EXISTS idx_field_answers_order
  ON applicant_field_answers(awl_id, link_id, sort_order);

-- ---- event log + system state --------------------------------------
CREATE TABLE IF NOT EXISTS application_events (
  id             INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  application_id INT,
  type           TEXT NOT NULL,
  actor          TEXT NOT NULL,
  payload_json   JSONB NOT NULL DEFAULT '{}'::jsonb,
  ts             TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_app ON application_events(application_id);

CREATE TABLE IF NOT EXISTS system_state (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- ---- NEW: execution history (needed once many users run in parallel)
-- Every engine spawn leaves a durable row: what ran, which applicant/link,
-- the outcome (incl. a distinct 'spam_blocked'), artefact trail and timing.
CREATE TABLE IF NOT EXISTS automation_runs (
  id             INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id         TEXT NOT NULL UNIQUE,
  application_id INT REFERENCES applications(id) ON DELETE SET NULL,
  awl_id         TEXT,
  link_id        INT,
  status         TEXT NOT NULL DEFAULT 'running',       -- running|success|pending|failed|spam_blocked|crash
  reason         TEXT,
  screenshot_path TEXT,
  screenshots_json JSONB,                               -- { pre_submit, acknowledgement } public URLs
  started_at     TEXT NOT NULL,
  finished_at    TEXT,
  duration_ms    INTEGER,
  attempts       INTEGER NOT NULL DEFAULT 1
);
CREATE INDEX IF NOT EXISTS idx_runs_app   ON automation_runs(application_id);
CREATE INDEX IF NOT EXISTS idx_runs_state ON automation_runs(status, started_at);

-- ---- pre-scan worker queue -----------------------------------------
-- One row per UNIQUE job link, however many AWL-IDs share it. This is what
-- makes scanning a *worker* rather than an in-process promise: the intent to
-- scan survives a restart, a claim is atomic (so two servers never open the
-- same form twice), and failures back off and retry instead of disappearing.
--   status: PENDING | RUNNING | DONE | FAILED
CREATE TABLE IF NOT EXISTS link_scan_jobs (
  id               INT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  url              TEXT NOT NULL,                           -- canonical (core/job-url.js)
  link_id          INT,                                     -- job_links.id when known
  reason           TEXT NOT NULL DEFAULT 'ingest',
  status           TEXT NOT NULL DEFAULT 'PENDING',
  attempts         INTEGER NOT NULL DEFAULT 0,
  max_attempts     INTEGER NOT NULL DEFAULT 3,
  fields           INTEGER NOT NULL DEFAULT 0,
  last_error       TEXT,
  claimed_by       TEXT,                                    -- process tag of the current scanner
  claimed_at       TEXT,
  next_attempt_at  TEXT,                                    -- backoff gate; NULL = due now
  started_at       TEXT,
  finished_at      TEXT,
  duration_ms      INTEGER,
  updated_at       TEXT NOT NULL,
  UNIQUE (url)
);
CREATE INDEX IF NOT EXISTS idx_scan_jobs_due ON link_scan_jobs(status, next_attempt_at);

