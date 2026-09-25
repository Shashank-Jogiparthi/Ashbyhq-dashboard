// Reframe the two ASHBY link tables in the AZURE CRM database to the exact
// minimal shape the platform needs, creating them when they are absent:
//
//   public.ashby_joblinks            awl_id   TEXT  PRIMARY KEY
//                                    job_links JSONB NOT NULL DEFAULT '[]'
//        -> who applies where: one row per applicant, holding the list of job
//           links assigned to that AWL-ID. This is where AWL-IDs + links come in.
//
//   public.ashby_joblink_questions   job_id   TEXT  PRIMARY KEY   (Ashby posting id)
//                                    job_link TEXT  NOT NULL UNIQUE
//                                    questions JSONB NOT NULL DEFAULT '[]'
//        -> what to answer: the pre-scanned question inventory of ONE link.
//           A link never changes, the number of applicants on it does, so the
//           questions are scanned once and reused by every applicant.
//
// Both tables may have arrived as clones of a `clients` template (id, name,
// telegram_chat_id, profile_dir, resume_path, enabled, timestamps, user_id ...).
// This script EMPTIES each table and drops every column outside the spec, then
// adds what is missing. Nothing else in the CRM is touched — in particular
// public.client_legacy is never read or modified.
//
//   cd ashbyhq-dashboard
//   node scripts/setup-link-tables.js              # inspect + reframe both
//   node scripts/setup-link-tables.js --dry-run     # show the plan only
//   node scripts/setup-link-tables.js --force       # allow emptying NON-EMPTY tables
//   node scripts/setup-link-tables.js --only ashby_joblinks

import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import { getPg, pgConfig } from '../connector/azure-config.js';

const here = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(here, '..', '.env') });
dotenv.config({ path: path.join(here, '..', '..', '.env') });

const SPECS = [
  {
    // The live table arrived as ("AWL-ID" integer DEFAULT nextval, job_link text,
    // joblink_id varchar). An integer identity can never hold an AWL-ID such as
    // "AWL-101", and a hyphen in a column name needs quoting in every query, so
    // the key becomes plain text `awl_id` (same convention as the platform DB).
    table: process.env.PG_AWL_LINKS_TABLE || 'public.ashby_joblinks',
    columns: [
      { name: 'awl_id', type: 'text', notNull: true, pk: true },
      { name: 'job_links', type: 'jsonb', notNull: true, defaultExpr: `'[]'::jsonb` }
    ]
  },
  {
    table: process.env.PG_QUESTIONS_TABLE || 'public.ashby_joblink_questions',
    columns: [
      { name: 'job_id', type: 'text', notNull: true, pk: true },
      { name: 'job_link', type: 'text', notNull: true, unique: true },
      { name: 'questions', type: 'jsonb', notNull: true, defaultExpr: `'[]'::jsonb` }
    ]
  }
];

const args = process.argv.slice(2);
const DRY = args.includes('--dry-run');
const FORCE = args.includes('--force');
const onlyIdx = args.indexOf('--only');
// NOTE: never args[onlyIdx + 1] when --only is absent — indexOf returns -1 and
// that would silently read args[0] (e.g. "--dry-run") and skip every table.
const only = onlyIdx >= 0 ? String(args[onlyIdx + 1] || '').replace(/^public\./, '') : '';

const cfg = pgConfig();
if (!cfg) {
  console.error('Azure CRM is not configured — set PGHOST / PGUSER / PGPASSWORD / PGDATABASE in the repo-root .env');
  process.exit(1);
}

const pg = await getPg();
const pool = new pg.Pool(cfg);
const run = (sql, params) => pool.query(sql, params);
const quote = (t) => { const [s, n] = t.split('.'); return `"${s}"."${n}"`; };

async function reframe(spec) {
  const [schema, name] = spec.table.includes('.') ? spec.table.split('.') : ['public', spec.table];
  const q = quote(`${schema}.${name}`);
  const wanted = spec.columns.map((c) => c.name);

  const cols = await run(
    `SELECT column_name, data_type FROM information_schema.columns
      WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [schema, name]);
  // Keep the REAL identifiers: a column created as "AWL-ID" is mixed-case and an
  // unquoted/lower-cased DROP COLUMN ... IF EXISTS would silently match nothing.
  const rawNames = cols.rows.map((r) => r.column_name);
  const present = rawNames.map((c) => c.toLowerCase());
  const types = Object.fromEntries(cols.rows.map((r) => [r.column_name.toLowerCase(), r.data_type.toLowerCase()]));

  console.log(`\n${schema}.${name}`);
  let rows = 0;
  if (!present.length) {
    console.log('  does not exist yet — it will be created.');
  } else {
    console.log(`  ${present.length} columns: ${present.join(', ')}`);
    rows = Number((await run(`SELECT count(*)::int AS n FROM ${q}`)).rows[0].n);
    console.log(`  ${rows} row(s) currently stored`);
  }

  const toDrop = present.filter((c) => !wanted.includes(c));
  const toDropRaw = rawNames.filter((c) => !wanted.includes(c.toLowerCase()));
  const toAdd = wanted.filter((c) => !present.includes(c));
  const retype = wanted.filter((c) => present.includes(c) && types[c] !== spec.columns.find((x) => x.name === c).type);
  const inShape = present.length === wanted.length && !toDrop.length && !retype.length;

  console.log(`  want : ${wanted.join(' | ')}`);
  if (toDrop.length) console.log(`  drop : ${toDrop.join(', ')}`);
  if (toAdd.length) console.log(`  add  : ${toAdd.join(', ')}`);
  if (retype.length) console.log(`  retype: ${retype.join(', ')}`);
  if (rows) console.log(`  empty: TRUNCATE (${rows} row(s) would be discarded)`);

  if (inShape && !toAdd.length && !rows) {
    console.log('  ✔ already in the required shape — nothing to do.');
    return;
  }
  if (rows && !FORCE && !DRY) {
    throw new Error(`refusing to empty a non-empty table — re-run with --force if you really mean it`);
  }
  if (DRY) { console.log('  (--dry-run)'); return; }

  if (!present.length) {
    await run(`CREATE SCHEMA IF NOT EXISTS "${schema}"`);
    const defs = spec.columns.map((c) =>
      `"${c.name}" ${c.type}${c.pk ? ' PRIMARY KEY' : `${c.notNull ? ' NOT NULL' : ''}${c.defaultExpr ? ` DEFAULT ${c.defaultExpr}` : ''}`}${c.unique && !c.pk ? ' UNIQUE' : ''}`);
    await run(`CREATE TABLE IF NOT EXISTS ${q} (\n    ${defs.join(',\n    ')}\n  )`);
    console.log('  ✔ created.');
    return;
  }

  await run('BEGIN');
  await run(`TRUNCATE TABLE ${q}`);
  for (const c of toDropRaw) await run(`ALTER TABLE ${q} DROP COLUMN IF EXISTS "${c}" CASCADE`);
  for (const c of spec.columns) {
    await run(`ALTER TABLE ${q} ADD COLUMN IF NOT EXISTS "${c.name}" ${c.type}`);
    if (c.notNull) await run(`ALTER TABLE ${q} ALTER COLUMN "${c.name}" SET NOT NULL`);
    else await run(`ALTER TABLE ${q} ALTER COLUMN "${c.name}" DROP NOT NULL`);
    if (c.defaultExpr) await run(`ALTER TABLE ${q} ALTER COLUMN "${c.name}" SET DEFAULT ${c.defaultExpr}`);
  }
  const cons = await run(
    `SELECT conname, contype FROM pg_constraint WHERE conrelid = $1::regclass AND contype IN ('p','u')`, [q]);
  for (const r of cons.rows) await run(`ALTER TABLE ${q} DROP CONSTRAINT IF EXISTS "${r.conname}"`);
  const pk = spec.columns.find((c) => c.pk);
  await run(`ALTER TABLE ${q} ADD CONSTRAINT ${name}_pkey PRIMARY KEY ("${pk.name}")`);
  for (const c of spec.columns.filter((x) => x.unique && !x.pk)) {
    await run(`ALTER TABLE ${q} ADD CONSTRAINT ${name}_${c.name}_key UNIQUE ("${c.name}")`);
  }
  await run('COMMIT');
  console.log('  ✔ reframed.');
}

try {
  for (const spec of SPECS) {
    const bare = spec.table.replace(/^public\./, '');
    if (only && bare !== only) continue;
    await reframe(spec);
  }
  console.log('\nFinal shapes:');
  for (const spec of SPECS) {
    const [schema, name] = spec.table.split('.');
    const after = await run(
      `SELECT column_name, data_type, is_nullable, column_default FROM information_schema.columns
        WHERE table_schema = $1 AND table_name = $2 ORDER BY ordinal_position`, [schema, name]);
    console.log(`  ${schema}.${name}${after.rowCount ? '' : '  (absent)'}`);
    for (const r of after.rows) {
      console.log(`    ${r.column_name.padEnd(11)} ${r.data_type.padEnd(10)} ${r.is_nullable === 'NO' ? 'NOT NULL' : 'NULL'} ${r.column_default ? `DEFAULT ${r.column_default}` : ''}`);
    }
    if (after.rowCount) {
      console.log(`    rows: ${Number((await run(`SELECT count(*)::int AS n FROM ${quote(spec.table)}`)).rows[0].n)}`);
    }
  }
} catch (err) {
  console.error(`\n✗ ${String(err.message || err).slice(0, 300)}`);
  await run('ROLLBACK').catch(() => {});
  process.exitCode = 1;
} finally {
  await pool.end();
}
