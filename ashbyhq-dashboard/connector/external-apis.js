/* =====================================================================
   External ApplyWizz read APIs (v3.7 CA work-history).

   THREE public GET endpoints, connected OUT OF THE BOX via built-in defaults:
     C  {ca_mgmt_base}/api/ca/emails            -> 59 active CAs {id,name,email,role}
                                                     (the career_associate_id -> email bridge)
     B  {ca_mgmt_base}/api/ca/work-history       -> per-CA day-span activity
        ?from&to&ca_email&page&pageSize
     A  {applywizz_base}/api/get-client-details  -> per-AWL applicant detail
        ?applywizz_id=

   The base URLs ship as DEFAULT_EXT_API below so the feature works with zero
   setup, but a DEV/ADMIN can OVERRIDE any of them at runtime from the DEV pane
   (stored in `system_state`, re-read at CALL time, so a save takes effect with
   no redeploy). Resolution rule: a key that was NEVER set falls back to the
   default (connected); a stored value wins; an explicitly BLANK value forces
   that feed cache-only (the { skipped:'not_configured' } degrade path). Nothing
   lives in .env, and an optional auth header/value is available for a future
   keyed endpoint without a code change.

   Every function accepts an optional { fetchImpl } so verify:flow can drive
   them with a fixture and never touch the network.
   ===================================================================== */
import { getSystemState } from '../db/store.js';

// system_state keys (the single place the names live).
export const EXT_API_KEYS = {
  caMgmtBase: 'ext_api.ca_mgmt_base',
  applywizzBase: 'ext_api.applywizz_base',
  authHeader: 'ext_api.auth_header',
  authValue: 'ext_api.auth_value',
};

// Built-in defaults so the endpoints are CONNECTED out of the box. A DEV/ADMIN
// override in system_state wins; clearing a field to blank disables that feed.
export const DEFAULT_EXT_API = {
  caMgmtBase: 'https://applywizz-ca-management.vercel.app',
  applywizzBase: 'https://www.apply-wizz.me',
};

// Short TTL so a DEV edit lands within a few seconds without a redeploy, but a
// burst of calls (e.g. one work-history page per CA) doesn't re-read the DB.
const TTL_MS = 15_000;
let _cache = { at: 0, val: null };

function strip(s) { return String(s || '').trim().replace(/\/+$/, ''); }

/** Resolve the current dynamic settings (cached briefly). */
export async function extApiSettings() {
  if (_cache.val && Date.now() - _cache.at < TTL_MS) return _cache.val;
  const [ca, awz, authHeader, authValue] = await Promise.all([
    getSystemState(EXT_API_KEYS.caMgmtBase, null),
    getSystemState(EXT_API_KEYS.applywizzBase, null),
    getSystemState(EXT_API_KEYS.authHeader, ''),
    getSystemState(EXT_API_KEYS.authValue, ''),
  ]);
  // null = never set -> built-in default (connected). A stored value (even a
  // blank one) is an explicit DEV/ADMIN choice and wins, so blank => cache-only.
  const caMgmtBase = ca === null ? DEFAULT_EXT_API.caMgmtBase : strip(ca);
  const applywizzBase = awz === null ? DEFAULT_EXT_API.applywizzBase : strip(awz);
  _cache = { at: Date.now(), val: { caMgmtBase, applywizzBase, authHeader: String(authHeader || '').trim(), authValue: String(authValue || '').trim() } };
  return _cache.val;
}

/** Drop the TTL cache (called right after a DEV saves new settings). */
export function clearExtApiCache() { _cache = { at: 0, val: null }; }

function authHeaders(cfg) {
  if (cfg.authHeader && cfg.authValue) return { [cfg.authHeader]: cfg.authValue };
  return {};
}

// Shared JSON GET. Throws an Error on a non-2xx so callers can classify.
async function fetchJson(url, { fetchImpl, headers = {} } = {}) {
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const res = await doFetch(url, { headers: { accept: 'application/json', ...headers } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

function qs(params) {
  const usp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && v !== '') usp.set(k, v);
  }
  const s = usp.toString();
  return s ? `?${s}` : '';
}

/** C: every active CA { id (=career_associate_id), name, email, role }. */
export async function caEmails({ fetchImpl } = {}) {
  const cfg = await extApiSettings();
  if (!cfg.caMgmtBase) return { ok: false, skipped: 'not_configured', users: [] };
  const data = await fetchJson(`${cfg.caMgmtBase}/api/ca/emails`,
    { fetchImpl, headers: authHeaders(cfg) });
  const users = Array.isArray(data?.users) ? data.users : (Array.isArray(data) ? data : []);
  return { ok: true, count: data?.count ?? users.length, users };
}

/** B: one page of a CA's work history. */
export async function workHistory({ caEmail, from, to, page = 1, pageSize = 100, fetchImpl } = {}) {
  const cfg = await extApiSettings();
  if (!cfg.caMgmtBase) return { ok: false, skipped: 'not_configured', records: [], total: 0 };
  const url = `${cfg.caMgmtBase}/api/ca/work-history${qs({ from, to, ca_email: caEmail, page, pageSize })}`;
  const data = await fetchJson(url, { fetchImpl, headers: authHeaders(cfg) });
  return {
    ok: data?.success !== false,
    records: Array.isArray(data?.records) ? data.records : [],
    total: Number(data?.total ?? (data?.records ? data.records.length : 0)),
    page: Number(data?.page ?? page),
    pageSize: Number(data?.pageSize ?? pageSize),
  };
}

/** B: page until the whole span for one CA is collected. */
export async function fetchAllWorkHistory({ caEmail, from, to, pageSize = 100, fetchImpl } = {}) {
  const all = [];
  let page = 1;
  for (let guard = 0; guard < 200; guard += 1) {         // hard page ceiling
    const r = await workHistory({ caEmail, from, to, page, pageSize, fetchImpl });
    if (!r.ok) return r;                                  // not_configured / error passthrough
    all.push(...r.records);
    if (!r.records.length || all.length >= r.total) break;
    page += 1;
  }
  return { ok: true, records: all, total: all.length };
}

/** A: optional per-AWL applicant detail (client + additional_information). */
export async function clientDetails(awlId, { fetchImpl } = {}) {
  const cfg = await extApiSettings();
  if (!cfg.applywizzBase) return { ok: false, skipped: 'not_configured' };
  const data = await fetchJson(`${cfg.applywizzBase}/api/get-client-details${qs({ applywizz_id: awlId })}`,
    { fetchImpl, headers: authHeaders(cfg) });
  return { ok: true, data };
}
