-- ASHBYHQ PLATFORM SCHEMA (local SQLite, node:sqlite)
-- Auth: email + role sign-up/sign-in, OTP code verification (Microsoft Authenticator flow stub).

CREATE TABLE IF NOT EXISTS staff (
  uuid TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('ca', 'ops', 'dev', 'admin')),
  manager_id TEXT REFERENCES staff(uuid), -- CA's OPS manager; NULL for OPS/DEV/ADMIN
  applicant_quota INTEGER NOT NULL DEFAULT 25, -- per-OPS cap WE set
  ext_id TEXT,                              -- external (Postgres) staff uuid, for sync mapping
  active INTEGER NOT NULL DEFAULT 1,
  last_sign_in TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS ams (
  uuid TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS otp_codes (
  email TEXT PRIMARY KEY,
  code TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  staff_uuid TEXT NOT NULL REFERENCES staff(uuid),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS job_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  company TEXT NOT NULL,
  title TEXT NOT NULL,
  url TEXT NOT NULL UNIQUE,
  url_hash TEXT NOT NULL,
  link_status TEXT NOT NULL DEFAULT 'valid', -- valid | expired | already_applied
  seeded_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS applicants (
  awl_id TEXT PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT NOT NULL,
  phone TEXT,
  am_id TEXT REFERENCES ams(uuid),
  ca_id TEXT REFERENCES staff(uuid),        -- set by the OPS manager (was AM in v2)
  ops_id TEXT REFERENCES staff(uuid),       -- owning OPS whose pool this applicant sits in
  ext_id TEXT,                              -- external client UUID from Postgres
  assigned_at TEXT,                         -- when the OPS attached a CA
  resume_address TEXT, -- path/URL where the resume already exists (never stored by us)
  profile_json TEXT NOT NULL DEFAULT '{}',
  parsed_profile_json TEXT,                  -- engine-parsed resume profile (structured, per AWL row)
  source_updated_at TEXT
);

-- (AWL-ID -> job link) pairs streamed from the external DB, waiting to be
-- materialised into applications when the OPS assigns the applicant to a CA.
CREATE TABLE IF NOT EXISTS applicant_joblinks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  awl_id TEXT NOT NULL REFERENCES applicants(awl_id),
  url TEXT NOT NULL,
  company TEXT NOT NULL DEFAULT '',
  title TEXT NOT NULL DEFAULT '',
  materialized INTEGER NOT NULL DEFAULT 0,  -- 0 = not yet turned into an application
  added_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_joblinks_pending ON applicant_joblinks(awl_id, materialized);

CREATE TABLE IF NOT EXISTS applications (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  awl_id TEXT NOT NULL REFERENCES applicants(awl_id),
  link_id INTEGER NOT NULL REFERENCES job_links(id),
  ca_id TEXT REFERENCES staff(uuid),
  manager_id TEXT REFERENCES staff(uuid),
  status TEXT NOT NULL DEFAULT 'ASSIGNED',
    -- ASSIGNED | QUEUED | APPLYING | SUCCESS | PENDING | FAILED
  skip_reason TEXT,
  fail_reason TEXT,
  run_id TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  screenshot_path TEXT,
  screenshots_json TEXT,                    -- { pre_submit, acknowledgement } public Supabase Storage URLs
  resolution_log_json TEXT,                 -- per-field source (rule|profile|ai|unresolved)
  decision_by TEXT,
  decision_at TEXT,
  queued_at TEXT,
  finished_at TEXT,
  purged_at TEXT,                          -- when post-SUCCESS form data was erased
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS application_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  application_id INTEGER,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload_json TEXT NOT NULL DEFAULT '{}',
  ts TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS system_state (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- Pre-automation scan: the full field inventory (question + control type +
-- options) captured from a job link's application form, cached per link and
-- reused for every applicant. field_key is a normalised question used to match
-- a stored CA/derived answer back to the same question across re-runs.
CREATE TABLE IF NOT EXISTS job_link_fields (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  link_id INTEGER NOT NULL REFERENCES job_links(id),
  field_key TEXT NOT NULL,
  question_text TEXT NOT NULL,
  field_type TEXT NOT NULL,                 -- text | textarea | select | radio | checkbox | combobox
  options_json TEXT NOT NULL DEFAULT '[]',  -- available choices for select/radio/combobox
  answered INTEGER NOT NULL DEFAULT 0,      -- 1 if the control already had a value at scan time
  required INTEGER,                         -- 1 form said required, 0 form said optional, NULL never said
  -- Which single applicant-record column answers this question, decided ONCE
  -- per link by the semantic mapper and reused for every applicant on it:
  -- NULL = never mapped, '' = mapped, record has nothing (essay question).
  bound_key TEXT,
  sort_order INTEGER NOT NULL DEFAULT 0,
  scanned_at TEXT NOT NULL,
  UNIQUE(link_id, field_key)
);
CREATE INDEX IF NOT EXISTS idx_joblink_fields ON job_link_fields(link_id);

-- Per-(applicant, link) resolved answer for every scanned field, produced by
-- the pre-Apply draft pass and edited by the CA. `source` drives the review UI:
--   deterministic -> auto-filled, shown read-only under "from profile"
--   genai         -> AI-drafted free-text/choice, CA must approve or edit
--   missing_fact  -> no data anywhere; CA must type a value or click Use N/A
--   ca_edited     -> value the CA typed/changed on the review pane
--   placeholder   -> Tier-4 stand-in (N/A / 0) recorded for auditability
CREATE TABLE IF NOT EXISTS applicant_field_answers (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  awl_id TEXT NOT NULL REFERENCES applicants(awl_id),
  link_id INTEGER NOT NULL REFERENCES job_links(id),
  field_key TEXT NOT NULL,
  question_text TEXT NOT NULL,
  field_type TEXT NOT NULL,
  options_json TEXT NOT NULL DEFAULT '[]',
  value TEXT,                              -- null for 'missing_fact' rows awaiting CA input
  source TEXT NOT NULL,                    -- deterministic | genai | missing_fact | ca_edited | placeholder
  evidence_json TEXT NOT NULL DEFAULT '[]',-- GenAI-cited source fragments (empty otherwise)
  optional INTEGER NOT NULL DEFAULT 0,     -- 1 = form marked [Optional]; CA may leave blank
  sort_order INTEGER NOT NULL DEFAULT 0,
  drafted_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(awl_id, link_id, field_key)
);
CREATE INDEX IF NOT EXISTS idx_field_answers ON applicant_field_answers(awl_id, link_id);

CREATE INDEX IF NOT EXISTS idx_applications_ca ON applications(ca_id, status);
CREATE INDEX IF NOT EXISTS idx_applications_manager ON applications(manager_id, status);
CREATE INDEX IF NOT EXISTS idx_applicants_ca ON applicants(ca_id);
CREATE INDEX IF NOT EXISTS idx_events_app ON application_events(application_id);

-- Durable work queue for the pre-scan worker: one row per UNIQUE job link, no
-- matter how many AWL-IDs are assigned to it. Replaces the old in-memory queue
-- so a restart mid-scan, a crashed browser or a flaky posting is retried
-- instead of silently forgotten. status: PENDING | RUNNING | DONE | FAILED.
CREATE TABLE IF NOT EXISTS link_scan_jobs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  url TEXT NOT NULL,                        -- canonical job link (core/job-url.js)
  link_id INTEGER,                          -- job_links.id when it exists yet
  reason TEXT NOT NULL DEFAULT 'ingest',    -- what queued it
  status TEXT NOT NULL DEFAULT 'PENDING',
  attempts INTEGER NOT NULL DEFAULT 0,
  max_attempts INTEGER NOT NULL DEFAULT 3,
  fields INTEGER NOT NULL DEFAULT 0,        -- questions captured by the last good scan
  last_error TEXT,
  claimed_by TEXT,                          -- process tag, so a dead claim can be re-taken
  claimed_at TEXT,
  next_attempt_at TEXT,                     -- backoff gate; NULL = due now
  started_at TEXT,
  finished_at TEXT,
  duration_ms INTEGER,
  updated_at TEXT NOT NULL,
  UNIQUE(url)
);
CREATE INDEX IF NOT EXISTS idx_scan_jobs_due ON link_scan_jobs(status, next_attempt_at);
