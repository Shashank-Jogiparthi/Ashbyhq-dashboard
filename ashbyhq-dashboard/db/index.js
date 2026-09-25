// ---------------------------------------------------------------------
// Dual-backend data layer.
//
//   * local  -> node:sqlite  (ashbyhq-dashboard/data/app.db)
//   * hosted -> Supabase Postgres via `pg` (SUPA_DB_URL / SUPA_* in .env)
//
// ONE code path: `db.prepare(sql).all/get/run(...)` is ALWAYS async, no
// matter which backend is active, so store.js never branches on the
// backend. Placeholders stay `?` everywhere and are rewritten to `$n` for
// Postgres. Selected by the presence of SUPA_DB_URL; override with
// DB_BACKEND=sqlite|supabase.
//
// NOTE: this module loads .env itself. It is imported (and therefore
// evaluated) before server.js reaches its dotenv.config() call, so without
// this the backend would always resolve to 'sqlite'.
// ---------------------------------------------------------------------
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { createRequire } from 'node:module';
import dotenv from 'dotenv';

const require = createRequire(import.meta.url);

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));
export const ROOT_DIR = path.resolve(MODULE_DIR, '..');
export const DATA_DIR = path.join(ROOT_DIR, 'data');
const REPO_ROOT = path.resolve(ROOT_DIR, '..');

// Load project .env first, then the repo-root .env (which holds SUPA_*/PG_*).
// dotenv never overwrites an already-set key, so order = precedence here.
dotenv.config({ path: path.join(ROOT_DIR, '.env') });
dotenv.config({ path: path.join(REPO_ROOT, '.env') });

const hasSupaConfig = Boolean(
  process.env.SUPA_DB_URL ||
  (process.env.SUPA_HOST && process.env.SUPA_USER && process.env.SUPA_PASSWORD)
);

export const BACKEND = process.env.DB_BACKEND
  ? process.env.DB_BACKEND
  : (hasSupaConfig ? 'supabase' : 'sqlite');

fs.mkdirSync(DATA_DIR, { recursive: true });

const SCHEMA_SQLITE = path.join(MODULE_DIR, 'schema.sql');
const SCHEMA_SUPABASE = path.join(MODULE_DIR, 'schema.supabase.sql');

/* ------------------------------------------------------------------ */
/* Postgres plumbing                                                   */
/* ------------------------------------------------------------------ */

let pool = null;
let sqliteDb = null;

// Type parsers that keep Postgres shaped exactly like the SQLite rows the
// application already expects:
//   int8/numeric -> Number   (ids and COUNT(*) stay plain numbers)
//   json/jsonb   -> raw TEXT  (store.js keeps doing JSON.parse on strings)
//   date/time    -> raw TEXT  (no Date objects, no timezone shifting)
function intParser(v) { return v === null ? null : Number(v); }
const passthrough = (v) => v;

async function getPool() {
  if (pool) return pool;
  const pg = await import('pg');
  const types = pg.types;
  types.setTypeParser(20, intParser);        // int8 / bigint
  types.setTypeParser(1700, intParser);      // numeric
  types.setTypeParser(3802, passthrough);    // jsonb  -> text
  types.setTypeParser(114, passthrough);     // json   -> text
  types.setTypeParser(1082, passthrough);    // date     -> text
  types.setTypeParser(1114, passthrough);    // timestamp -> text
  types.setTypeParser(1184, passthrough);  // timestamptz -> text
  
  const connectionString = process.env.SUPA_DB_URL || null;
  const base = {
    max: Number(process.env.SUPA_POOL_MAX || 10),
    connectionTimeoutMillis: 15000,
    idleTimeoutMillis: 30000,
    ssl: process.env.SUPA_SSL === 'false' ? false : { rejectUnauthorized: false }
  };
  pool = connectionString
    ? new pg.default.Pool({ connectionString, ...base })
    : new pg.default.Pool({
        host: process.env.SUPA_HOST,
        port: Number(process.env.SUPA_PORT || 5432),
        user: process.env.SUPA_USER,
        password: process.env.SUPA_PASSWORD,
        database: process.env.SUPA_DATABASE || 'postgres',
        ...base
      });
  return pool;
}

function getSqlite() {
  if (sqliteDb) return sqliteDb;
  const { DatabaseSync } = require('node:sqlite');
  sqliteDb = new DatabaseSync(path.join(DATA_DIR, 'app.db'));
  sqliteDb.exec('PRAGMA journal_mode = WAL;');
  return sqliteDb;
}

/** Rewrite SQLite `?` placeholders into Postgres `$1, $2, ...`.
 *  Quote/comment aware so a literal '?' inside a string is left alone. */
function toPgParams(sql) {
  let out = '';
  let n = 0;
  for (let i = 0; i < sql.length; i += 1) {
    const ch = sql[i];
    if (ch === "'" || ch === '"' || ch === '`') {
      const quote = ch;
      out += ch;
      i += 1;
      while (i < sql.length) {
        if (sql[i] === '\\' && quote === '`') { out += sql[i] + (sql[i + 1] ?? ''); i += 2; continue; }
        if (sql[i] === quote) {
          if (sql[i + 1] === quote) { out += quote + quote; i += 2; continue; } // '' escape
          out += quote; break;
        }
        out += sql[i]; i += 1;
      }
      continue;
    }
    if (ch === '-' && sql[i + 1] === '-') {
      while (i < sql.length && sql[i] !== '\n') { out += sql[i]; i += 1; }
      i -= 1; out += '\n'; continue;
    }
    if (ch === '/' && sql[i + 1] === '*') {
      out += '/*'; i += 2;
      while (i < sql.length && !(sql[i] === '*' && sql[i + 1] === '/')) { out += sql[i]; i += 1; }
      out += '*/'; i += 1; continue;
    }
    if (ch === '?') { n += 1; out += `$${n}`; continue; }
    out += ch;
  }
  return out;
}

const norm = (params) => params.map((p) => (p === undefined ? null : p));

/* ------------------------------------------------------------------ */
/* Statement / facade API                                              */
/* ------------------------------------------------------------------ */

class Stmt {
  constructor(sql, client = null) {
    this.sql = sql;
    this.client = client;   // set only inside a hosted transaction
  }

  async _send(method, params) {
    if (BACKEND === 'supabase') {
      const sql = toPgParams(this.sql);
      const values = norm(params);
      if (this.client) return this.client.query(sql, values);
      const p = await getPool();
      return p.query(sql, values);
    }
    const stmt = getSqlite().prepare(this.sql);
    if (method === 'all') return { rows: stmt.all(...norm(params)) };
    if (method === 'get') { const r = stmt.get(...norm(params)); return { rows: r === undefined ? [] : [r] }; }
    return { changes: 0, rows: [], _sqliteRun: stmt.run(...norm(params)) };
  }

  /** All matching rows. */
  async all(...params) {
    const r = await this._send('all', params);
    return BACKEND === 'supabase' ? r.rows : r.rows;
  }

  /** First row, or undefined (mirrors SQLite `.get()`). */
  async get(...params) {
    const r = await this._send('get', params);
    return r.rows[0];
  }

  /** Write. Returns { changes, lastInsertRowid } like SQLite's run(). */
  async run(...params) {
    if (BACKEND !== 'supabase') {
      const r = await this._send('run', params);
      const info = r._sqliteRun;
      return { changes: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid) };
    }
    const r = await this._send('run', params);
    return { changes: r.rowCount ?? 0, lastInsertRowid: null };
  }
}

async function execSql(sql) {
  if (BACKEND === 'supabase') {
    const p = await getPool();
    await p.query(sql);       // multi-statement DDL is fine on a simple query
    return;
  }
  getSqlite().exec(sql);
}

/**
 * Run `fn(t)` inside a transaction. `t.prepare(sql)` binds every statement
 * to the same connection, so the block is atomic on both backends.
 */
async function tx(fn) {
  if (BACKEND !== 'supabase') {
    const s = getSqlite();
    s.exec('BEGIN');
    try {
      const out = await fn({ prepare: (sql) => new Stmt(sql, null) });
      s.exec('COMMIT');
      return out;
    } catch (err) {
      try { s.exec('ROLLBACK'); } catch { /* already aborted */ }
      throw err;
    }
  }
  const p = await getPool();
  const client = await p.connect();
  try {
    await client.query('BEGIN');
    const out = await fn({ prepare: (sql) => new Stmt(sql, client) });
    await client.query('COMMIT');
    return out;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch { /* aborted */ }
    throw err;
  } finally {
    client.release();
  }
}

export const db = {
  backend: BACKEND,
  prepare: (sql) => new Stmt(sql, null),
  exec: execSql,
  tx
};

/* ------------------------------------------------------------------ */
/* MIGRATE                                                             */
/* ------------------------------------------------------------------ */

export async function migrate() {
  if (BACKEND === 'supabase') {
    await getPool();                       // fails fast on bad credentials
    await migrateCamToOpsPostgres();       // FIRST: rename cam_id->ops_id on existing DB (no-op on fresh)
    await execSql(fs.readFileSync(SCHEMA_SUPABASE, 'utf8')); // then create any missing tables/indexes
    await ensureScreenshotColumnsPostgres(); // idempotent: adds screenshots_json
    console.log(`Database ready: Supabase Postgres (${process.env.SUPA_DB_URL ? 'SUPA_DB_URL' : process.env.SUPA_HOST})`);
    return;
  }
  const s = getSqlite();
  s.exec(fs.readFileSync(SCHEMA_SQLITE, 'utf8'));
  ensureColumnSqlite('staff', 'applicant_quota', 'INTEGER NOT NULL DEFAULT 25');
  ensureColumnSqlite('staff', 'ext_id', 'TEXT');
  ensureColumnSqlite('applicants', 'ext_id', 'TEXT');
  ensureColumnSqlite('applicants', 'assigned_at', 'TEXT');
  ensureColumnSqlite('applications', 'resolution_log_json', 'TEXT');
  ensureColumnSqlite('job_links', 'scan_status', "TEXT NOT NULL DEFAULT 'unscanned'");
  ensureColumnSqlite('job_links', 'scanned_at', 'TEXT');
  ensureColumnSqlite('job_link_fields', 'needs_genai', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumnSqlite('job_link_fields', 'question_summary', 'TEXT');
  ensureColumnSqlite('job_link_fields', 'bound_key', 'TEXT');
  ensureColumnSqlite('job_link_fields', 'required', 'INTEGER');
  ensureColumnSqlite('applicant_field_answers', 'optional', 'INTEGER NOT NULL DEFAULT 0');
  ensureColumnSqlite('applications', 'screenshots_json', 'TEXT');
  ensureColumnSqlite('applications', 'purged_at', 'TEXT');
  migrateCamToOpsSqlite(s);
  console.log(`Database ready: ${path.join(DATA_DIR, 'app.db')}`);
}

// CREATE IF NOT EXISTS never alters an existing table, so new columns on a
// pre-existing local database need explicit ALTERs.
function ensureColumnSqlite(table, column, ddl) {
  const s = getSqlite();
  const cols = s.prepare(`PRAGMA table_info(${table})`).all();
  if (cols.some((c) => c.name === column)) return;
  s.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  console.log(`migrate: added column ${table}.${column}`);
}

// One-time, idempotent rename of the CAM role -> OPS on the hosted Postgres:
//   * staff.role value 'cam' -> 'ops' (via a widened then tightened CHECK)
//   * applicants.cam_id column -> ops_id (+ index rename), if the old shape
//     is present. Fresh databases are created already in the OPS shape by
//     schema.supabase.sql, so every step is guarded and safe to re-run.
// ADD COLUMN IF NOT EXISTS is safe to re-run every boot; it backs an existing
// hosted DB with the screenshots_json column the run pipeline now writes.
async function ensureScreenshotColumnsPostgres() {
  const p = await getPool();
  await p.query('ALTER TABLE applications ADD COLUMN IF NOT EXISTS screenshots_json JSONB');
  await p.query('ALTER TABLE automation_runs ADD COLUMN IF NOT EXISTS screenshots_json JSONB');
  await p.query('ALTER TABLE applications ADD COLUMN IF NOT EXISTS purged_at TEXT');
  // Semantic question -> record-column binding, computed once per link.
  await p.query('ALTER TABLE job_link_fields ADD COLUMN IF NOT EXISTS bound_key TEXT');
  await p.query('ALTER TABLE job_link_fields ADD COLUMN IF NOT EXISTS required SMALLINT');
}

async function migrateCamToOpsPostgres() {
  const p = await getPool();
  // Fresh DB? The schema file already creates ops-shaped tables, so there is
  // nothing to rename. Guard so this can safely run BEFORE execSql(schema);
  // on an existing (legacy) DB the tables are present and get reshaped here.
  const exists = await p.query("SELECT to_regclass('public.staff') IS NOT NULL AS ok");
  if (!exists.rows[0]?.ok) return;
  await p.query('ALTER TABLE staff DROP CONSTRAINT IF EXISTS staff_role_check');
  await p.query("ALTER TABLE staff ADD CONSTRAINT staff_role_check CHECK (role IN ('ca','cam','ops','dev','admin'))");
  const upd = await p.query("UPDATE staff SET role = 'ops' WHERE role = 'cam'");
  await p.query('ALTER TABLE staff DROP CONSTRAINT IF EXISTS staff_role_check');
  await p.query("ALTER TABLE staff ADD CONSTRAINT staff_role_check CHECK (role IN ('ca','ops','dev','admin'))");
  await p.query(`DO $$ BEGIN
    IF EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='applicants' AND column_name='cam_id')
       AND NOT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_name='applicants' AND column_name='ops_id') THEN
      ALTER TABLE applicants RENAME COLUMN cam_id TO ops_id;
    END IF;
  END $$;`);
  await p.query('ALTER INDEX IF EXISTS idx_applicants_cam RENAME TO idx_applicants_ops');
  await p.query('CREATE INDEX IF NOT EXISTS idx_applicants_ops ON applicants(ops_id)');
  if (upd.rowCount) console.log(`migrate: promoted ${upd.rowCount} staff row(s) role cam -> ops`);
}

// SQLite mirror of migrateCamToOpsPostgres(): rebuild the staff CHECK to the
// ca|ops|dev|admin set (migrating any 'cam' rows) and rename applicants.cam_id
// -> ops_id. Also covers the older 'admin'-missing rebuild in one pass.
function migrateCamToOpsSqlite(s) {
  const staffRow = s.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name='staff'").get();
  if (!staffRow || !/'ops'/.test(staffRow.sql)) {
    console.log('migrate: rebuilding staff to the ca|ops|dev|admin role set...');
    s.exec('PRAGMA foreign_keys = OFF;');
    try {
      s.exec('BEGIN');
      s.exec(`CREATE TABLE staff_new (
        uuid TEXT PRIMARY KEY,
        email TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('ca', 'ops', 'dev', 'admin')),
        manager_id TEXT REFERENCES staff_new(uuid),
        applicant_quota INTEGER NOT NULL DEFAULT 25,
        ext_id TEXT,
        active INTEGER NOT NULL DEFAULT 1,
        last_sign_in TEXT,
        created_at TEXT NOT NULL
      )`);
      s.exec("UPDATE staff SET role = 'ops' WHERE role = 'cam'");
      s.prepare(`INSERT INTO staff_new
        (uuid, email, name, role, manager_id, applicant_quota, ext_id, active, last_sign_in, created_at)
        SELECT uuid, email, name, role, manager_id, applicant_quota, ext_id, active, last_sign_in, created_at
        FROM staff`).run();
      s.exec('DROP TABLE staff');
      s.exec('ALTER TABLE staff_new RENAME TO staff');
      s.exec('COMMIT');
    } catch (err) {
      s.exec('ROLLBACK');
      throw err;
    } finally {
      s.exec('PRAGMA foreign_keys = ON;');
    }
  } else {
    s.prepare("UPDATE staff SET role = 'ops' WHERE role = 'cam'").run();
  }
  // applicants.cam_id -> ops_id
  const cols = s.prepare('PRAGMA table_info(applicants)').all().map((c) => c.name);
  if (cols.includes('cam_id') && !cols.includes('ops_id')) {
    s.exec('ALTER TABLE applicants RENAME COLUMN cam_id TO ops_id');
  } else {
    if (!cols.includes('ops_id')) s.exec('ALTER TABLE applicants ADD COLUMN ops_id TEXT');
    if (cols.includes('cam_id')) {
      s.exec('UPDATE applicants SET ops_id = cam_id WHERE ops_id IS NULL AND cam_id IS NOT NULL');
      try { s.exec('ALTER TABLE applicants DROP COLUMN cam_id'); } catch { /* harmless leftover */ }
    }
  }
  try { s.exec('CREATE INDEX IF NOT EXISTS idx_applicants_ops ON applicants(ops_id)'); } catch { /* ignore */ }
}

export function nowIso() {
  return new Date().toISOString();
}

export function uuid() {
  return crypto.randomUUID();
}
