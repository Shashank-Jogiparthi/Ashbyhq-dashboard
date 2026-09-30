/* =====================================================================
   External ApplyWizz read APIs (v3.7 CA work-history).

   THREE public GET endpoints, none of whose hosts are hardcoded here:
     C  {ca_mgmt_base}/api/ca/emails            -> 59 active CAs {id,name,email,role}
                                                     (the career_associate_id -> email bridge)
     B  {ca_mgmt_base}/api/ca/work-history       -> per-CA day-span activity
        ?from&to&ca_email&page&pageSize
     A  {applywizz_base}/api/get-client-details  -> optional per-AWL detail
        ?applywizz_id=

   The base URLs (and an OPTIONAL auth header/value for a future keyed
   endpoint) are DEV/ADMIN-managed DYNAMIC settings read from `system_state`
   at CALL time, so a change in the DEV pane takes effect with no redeploy and
   there is nothing to leak into source. If `ca_mgmt_base` is unset every call
   degrades to { ok:false, skipped:'not_configured' } rather than throwing, so
   the dashboard still serves whatever is already cached.

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

// Short TTL so a DEV edit lands within a few seconds without a redeploy, but a
// burst of calls (e.g. one work-history page per CA) doesn't re-read the DB.
const TTL_MS = 15_000;
let _cache = { at: 0, val: null };

function strip(s) { return String(s || '').trim().replace(/\/+$/, ''); }

/** Resolve the current dynamic settings (cached briefly). */
export async function extApiSettings() {
  if (_cache.val && Date.now() - _cache.at < TTL_MS) return _cache.val;
  const [caMgmtBase, applywizzBase, authHeader, authValue] = await Promise.all([
    getSystemState(EXT_API_KEYS.caMgmtBase, ''),
    getSystemState(EXT_API_KEYS.applywizzBase, ''),
    getSystemState(EXT_API_KEYS.authHeader, ''),
    getSystemState(EXT_API_KEYS.authValue, ''),
  ]);
  _cache = { at: Date.now(), val: { caMgmtBase: strip(caMgmtBase), applywizzBase: strip(applywizzBase), authHeader: String(authHeader || '').trim(), authValue: String(authValue || '').trim() } };
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
