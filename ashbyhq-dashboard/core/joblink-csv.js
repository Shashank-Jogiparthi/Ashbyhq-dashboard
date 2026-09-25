/* =====================================================================
 (AWL-ID -> job link) TABLE PARSER

 One parser for both ways a DEV hands us assignments: a pasted text block (one
 pair per line, any spacing) and a .csv / .tsv export from the CRM or a
 spreadsheet. The DEV tab uploads a file, reads it as text and posts it to
 /api/dev/links, which runs it through here - so a file and a paste can never
 drift apart into two different rules.

 Accepted shapes
   awl_id,job_link                       <- header row (names are matched loosely)
   AWL-101,https://jobs.ashbyhq.com/...  <- header-less CSV
   AWL-101  https://jobs.ashbyhq.com/... <- pasted / single-column lines
   # comment                             <- ignored

 Column synonyms (case, spaces and _ - are ignored):
   AWL-ID   : awlid | awl | awlidnumber | applywizzid | applicantid | id
   Link     : joblink | joburl | url | link | applyurl | postingurl | href
   Optional : company, title (kept when present so a link is not named "Unknown")

 Anything that is not an AWL-ID + URL pair is reported in `skipped` with a
 reason instead of being guessed at: a silently mis-ingested link applies the
 wrong applicant to the wrong job.
 ===================================================================== */
import { canonicalJobUrl } from './job-url.js';
// Same canonical key rule the CRM connector uses ("awl101"/"AWL-101"/" AWL 101 "
// -> "AWL-101"). Imported rather than re-implemented: two copies of an identity
// rule is how the same applicant ends up as two rows.
import { normalizeAwlId } from '../connector/applicant-db.js';

const AWL_TOKEN = /AWL-?\d+/i;
const URL_TOKEN = /https?:\/\/\S+/i;
// An AWL-ID column that does not spell itself "AWL<n>" is only trusted when it
// is a short single token ("101", "XZ-42"). Prose in that cell means the header
// was matched against the wrong column, and a plausible-looking wrong id would
// attach a real applicant to somebody else's job.
const BARE_ID = /^\s*[A-Z0-9][A-Z0-9_.:-]{0,23}\s*$/i;
const AWL_OR_NUMBER = /^\s*(?:AWL[-_ ]?)?\d{1,12}\s*$/i;

const clean = (s) => String(s ?? '').replace(/^\uFEFF/, '').trim();
// "Job Link" / "applywizz_id" / "AWL-ID" all collapse to the same key.
const norm = (s) => clean(s).toLowerCase().replace(/[^a-z0-9]/g, '');

// Ordered MOST specific first: a CRM export with both "id" (its own primary key)
// and "applywizz_id" must pick the latter, so column order cannot decide.
const AWL_KEYS = ['applywizzid', 'applywizzidnumber', 'awlid', 'awlidnumber', 'applicantid', 'awlno', 'awl', 'id'];
const LINK_KEYS = ['joblink', 'joblinkurl', 'joburl', 'jobpostingurl', 'postingurl', 'applyurl', 'jobslink', 'url', 'link', 'href'];
const COMPANY_KEYS = ['company', 'companyname', 'organization', 'org', 'clientcompany'];
const TITLE_KEYS = ['title', 'jobtitle', 'role', 'position', 'designation', 'profile'];

/** Split into rows of cells, honouring "quoted, commas" and newlines in quotes. */
function splitRows(text, delim) {
  const rows = [];
  let row = [];
  let cell = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { cell += '"'; i += 1; }   // "" is one literal quote
        else quoted = false;
      } else cell += ch;
      continue;
    }
    if (ch === '"') { quoted = true; continue; }
    if (ch === delim) { row.push(cell); cell = ''; continue; }
    if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; continue; }
    if (ch === '\r') continue;
    cell += ch;
  }
  row.push(cell);
  rows.push(row);
  return rows;
}

/** Most frequent candidate delimiter on the first line wins (TSV exports too). */
function detectDelimiter(text) {
  const firstLine = String(text || '').split(/\r?\n/, 1)[0] || '';
  let best = ',';
  let bestCount = -1;
  for (const d of [',', '\t', ';', '|']) {
    let count = 0;
    let quoted = false;
    for (const ch of firstLine) {
      if (ch === '"') quoted = !quoted;
      else if (ch === d && !quoted) count += 1;
    }
    if (count > bestCount) { bestCount = count; best = d; }
  }
  return best;
}

function mapHeader(cells) {
  // Best synonym rank wins, not first column seen.
  const best = { awl: -1, url: -1, company: -1, title: -1 };
  const rank = { awl: Infinity, url: Infinity, company: Infinity, title: Infinity };
  const consider = (slot, keys, i, key) => {
    const r = keys.indexOf(key);
    if (r !== -1 && r < rank[slot]) { rank[slot] = r; best[slot] = i; }
  };
  cells.forEach((c, i) => {
    const key = norm(c);
    if (!key) return;
    consider('awl', AWL_KEYS, i, key);
    consider('url', LINK_KEYS, i, key);
    consider('company', COMPANY_KEYS, i, key);
    consider('title', TITLE_KEYS, i, key);
  });
  const idx = { awl: rank.awl === Infinity ? -1 : best.awl, url: rank.url === Infinity ? -1 : best.url,
    company: rank.company === Infinity ? -1 : best.company, title: rank.title === Infinity ? -1 : best.title };
  // A header must name BOTH sides of the pair, or it is just data.
  return idx.awl !== -1 && idx.url !== -1 ? idx : null;
}

/**
 * @returns {{pairs: Array<{awlId:string,url:string,company?:string,title?:string,line:number}>,
 *            skipped: Array<{line:number, value:string, reason:string}>, header: boolean}}
 */
export function parseAwlLinkTable(text) {
  const raw = String(text ?? '').replace(/^\uFEFF/, '');
  const delim = detectDelimiter(raw);
  const rows = splitRows(raw, delim);
  const pairs = [];
  const skipped = [];
  const seen = new Set();

  let header = null;
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 5); i++) {
    if (rows[i].every((c) => !clean(c))) continue;
    if (rows[i].map(clean).join(' ').startsWith('#')) continue;   // "# exported from ..."
    const mapped = mapHeader(rows[i]);
    if (mapped) { header = mapped; headerIdx = i; }
    break;                                     // only the first real line can be a header
  }

  const push = (awlRaw, urlRaw, line, company = '', title = '') => {
    const flat = String(awlRaw || '').replace(/\s+/g, '');
    const awlMatch = flat.match(AWL_TOKEN);
    // Without an explicit AWL token the value only survives the shape gates
    // below, so normalizeAwlId still gets to canonicalise "AWL101" -> "AWL-101".
    if (!awlMatch && !AWL_OR_NUMBER.test(String(awlRaw || '')) && !BARE_ID.test(String(awlRaw || ''))) {
      skipped.push({ line, value: clean(awlRaw).slice(0, 120), reason: 'AWL-ID column is not an id (check the header)' });
      return;
    }
    const awlId = normalizeAwlId(awlMatch ? awlMatch[0] : awlRaw);
    const url = canonicalJobUrl(clean(urlRaw));
    if (!awlId) { skipped.push({ line, value: clean(urlRaw) || clean(awlRaw), reason: 'no AWL-ID' }); return; }
    if (!/^https?:\/\//i.test(url)) { skipped.push({ line, value: `${awlId} -> ${clean(urlRaw)}`, reason: 'no http(s) job link' }); return; }
    const dedupe = `${awlId}|${url}`;
    if (seen.has(dedupe)) return;              // repeats are normal in a CRM export
    seen.add(dedupe);
    pairs.push({ awlId, url, company: clean(company), title: clean(title), line });
  };

  rows.forEach((cells, i) => {
    if (i === headerIdx) return;
    if (cells.every((c) => !clean(c))) return;
    const joined = cells.map(clean).join(' ');
    if (joined.startsWith('#')) return;

    if (header) {
      push(cells[header.awl], cells[header.url], i + 1,
        header.company > -1 ? cells[header.company] : '',
        header.title > -1 ? cells[header.title] : '');
      return;
    }
    // Header-less: pull the two tokens out of the row instead of trusting a
    // column order, because exports differ (link first, id last, status in the
    // middle) and guessing wrong assigns a real person to the wrong job.
    const awl = joined.match(AWL_TOKEN);
    const url = joined.match(URL_TOKEN);
    if (awl && url) push(awl[0], url[0], i + 1);
    else skipped.push({ line: i + 1, value: joined.slice(0, 160), reason: 'row has no AWL-ID + job link pair' });
  });

  return { pairs, skipped, header: Boolean(header) };
}
