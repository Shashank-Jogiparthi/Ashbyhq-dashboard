/* ASHBYHQ dashboard — role-scoped skeleton UI (CA / OPS / DEV) */
const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v) => (v ? new Date(v).toLocaleString() : '—');

let ME = null;
let TABS = [];
let ACTIVE_TAB = null;

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('awl_token') || ''}` },
    ...options
  });
  if (res.status === 401) {
    localStorage.removeItem('awl_token');
    location.href = '/index.html';
    throw new Error('Signed out');
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function chip(status) {
  return `<span class="chip ${esc(status)}">${esc(status)}</span>`;
}

function statsHtml(c) {
  const cell = (label, value, cls = '') => `<div class="stat ${cls}"><div class="label">${label}</div><div class="value">${value}</div></div>`;
  return `<div class="stat-grid">
    ${cell('Total', c.TOTAL, 'blue')}
    ${cell('Assigned', c.ASSIGNED)}
    ${cell('Queued', c.QUEUED, 'blue')}
    ${cell('Applying', c.APPLYING, 'yellow')}
    ${cell('Success', c.SUCCESS, 'green')}
    ${cell('Pending', c.PENDING, 'yellow')}
    ${cell('Failed', c.FAILED, 'red')}
  </div>`;
}

function toast(message, isError = false) {
  const box = document.createElement('div');
  box.className = isError ? 'error-box' : 'ok-box';
  box.style.cssText = 'position:fixed;top:70px;right:20px;z-index:50;max-width:380px;';
  box.textContent = message;
  document.body.appendChild(box);
  setTimeout(() => box.remove(), 4200);
}

/* --------------------------- boot / shell -------------------------- */

const ROLE_TABS = {
  ca: [
    { id: 'applicants', label: 'My Applicants' },
    { id: 'activity', label: 'My Activity' }
  ],
  ops: [
    { id: 'overview', label: 'Overview' },
    { id: 'assignments', label: 'Assignments' },
    { id: 'caview', label: 'CA Overview' },
    { id: 'applicants', label: 'Applicants' },
    { id: 'links', label: 'Job Links' },
    { id: 'applications', label: 'Applications' },
    { id: 'activity', label: 'Activity' }
  ],
  dev: [
    { id: 'system', label: 'System' },
    { id: 'datasync', label: 'Data Sync' },
    { id: 'queue', label: 'Queue' },
    { id: 'applicants', label: 'Applicants' },
    { id: 'applications', label: 'Applications' },
    { id: 'staff', label: 'Staff' },
    { id: 'people', label: 'People' },
    { id: 'events', label: 'Events' },
    { id: 'tables', label: 'Raw Tables' }
  ],
  // ADMIN = full DEV access, plus the Staff tab gains role-change + member
  // removal controls (rendered only when ME.role === 'admin').
  admin: [
    { id: 'system', label: 'System' },
    { id: 'datasync', label: 'Data Sync' },
    { id: 'queue', label: 'Queue' },
    { id: 'applicants', label: 'Applicants' },
    { id: 'applications', label: 'Applications' },
    { id: 'staff', label: 'Staff & Members' },
    { id: 'people', label: 'People' },
    { id: 'events', label: 'Events' },
    { id: 'tables', label: 'Raw Tables' }
  ]
};

const RENDERERS = {
  applicants: renderApplicantsTab,
  activity: renderActivity,
  overview: renderOpsOverview,
  assignments: renderOpsAssignments,
  caview: renderOpsCaView,
  people: renderDevPeople,
  links: renderOpsLinks,
  applications: renderApplicationsTable,
  system: renderDevSystem,
  datasync: renderDevDataSync,
  queue: renderDevQueue,
  staff: renderDevStaff,
  events: renderDevEvents,
  tables: renderDevTables
};

async function boot() {
  try {
    ME = await api('/api/me');
  } catch { return; }
  $('dash-title').textContent = `${ME.role.toUpperCase()} dashboard`;
  $('role-chip').className = `chip role-${ME.role}`;
  $('role-chip').textContent = ME.role.toUpperCase();
  const under = ME.managerName ? ` · under OPS ${esc(ME.managerName)}` : '';
  $('who').innerHTML = `<b>${esc(ME.name)}</b><br><span class="muted">${esc(ME.email)}${under}</span>`;
  TABS = ROLE_TABS[ME.role] || [];
  ACTIVE_TAB = ACTIVE_TAB || TABS[0].id;
  drawTabs();
  await openTab(ACTIVE_TAB);
}

function drawTabs() {
  $('tabs').innerHTML = TABS.map((t) =>
    `<button data-tab="${t.id}" class="${t.id === ACTIVE_TAB ? 'active' : ''}">${t.label}</button>`
  ).join('');
  $('tabs').querySelectorAll('button').forEach((btn) => {
    btn.addEventListener('click', () => openTab(btn.dataset.tab));
  });
}

async function openTab(tabId) {
  ACTIVE_TAB = tabId;
  drawTabs();
  $('view').innerHTML = '<p class="muted">Loading…</p>';
  try {
    await RENDERERS[tabId]();
  } catch (err) {
    $('view').innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
  }
}

$('btn-refresh').addEventListener('click', () => openTab(ACTIVE_TAB));
$('btn-signout').addEventListener('click', async () => {
  try { await api('/api/auth/logout', { method: 'POST' }); } catch { /* ignore */ }
  localStorage.removeItem('awl_token');
  location.href = '/index.html';
});

/* ------------------------ shared table helper ---------------------- */

function tableHtml(headers, rows) {
  if (!rows.length) return '<p class="muted">Nothing here yet.</p>';
  return `<div style="overflow-x:auto;"><table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead>
    <tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`;
}

/* --------------------- applicants + CA queue ----------------------- */

async function renderApplicantsTab() {
  const [{ applicants }, { applications }] = await Promise.all([
    api('/api/ca/applicants'),
    api('/api/ca/applications')
  ]);

  if (ME.role === 'ca') {
    $('view').innerHTML = `
      ${statsHtml(countersFrom(applications))}
      <div class="dir-layout">
        <div>
          <h3 style="margin:4px 0;">👥 Candidates Directory <span class="chip">${applicants.length}</span></h3>
          <input id="dir-search" placeholder="Search name or AWL-ID…" style="margin-bottom:10px;" />
          <div class="dir-list" id="dir-list"></div>
        </div>
        <div id="queue-pane"><p class="muted">Select an applicant to see their assigned job links.</p></div>
      </div>`;
    const state = { selected: applicants[0]?.awl_id || null, query: '' };
    const draw = () => drawDirectory(state, applicants, applications);
    draw();
    $('dir-search').addEventListener('input', (e) => { state.query = e.target.value.toLowerCase(); draw(); });
    if (state.selected) drawQueue(state.selected, applications);
    window.__awlRefreshTab = () => openTab('applicants');
    return;
  }

  // OPS / DEV reuse this tab as a plain applicants table
  $('view').innerHTML = tableHtml(
    ['AWL-ID', 'Name', 'Email', 'AM', 'CA', 'OPS', 'Jobs', 'Resume address'],
    applicants.map((a) => [
      `<span class="mono">${esc(a.awl_id)}</span>`, esc(a.full_name), esc(a.email),
      esc(a.am_name || '—'), esc(a.ca_name || '—'), esc(a.manager_name || '—'),
      a.job_count, `<span class="mono">${esc(a.resume_address || '—')}</span>`
    ])
  );
}

function countersFrom(applications) {
  const c = { ASSIGNED: 0, QUEUED: 0, APPLYING: 0, SUCCESS: 0, PENDING: 0, FAILED: 0, TOTAL: applications.length };
  for (const a of applications) c[a.status] = (c[a.status] || 0) + 1;
  return c;
}

function drawDirectory(state, applicants, applications) {
  const list = applicants.filter((a) =>
    !state.query || a.full_name.toLowerCase().includes(state.query) || a.awl_id.toLowerCase().includes(state.query));
  $('dir-list').innerHTML = list.map((a) => {
    const mine = applications.filter((x) => x.awl_id === a.awl_id);
    const applied = mine.filter((x) => x.status === 'SUCCESS').length;
    return `<div class="card ap-card ${state.selected === a.awl_id ? 'selected' : ''}" data-awl="${esc(a.awl_id)}">
      <div class="row"><span class="mono">${esc(a.awl_id)}</span>
        <span class="chip">${mine.length} Jobs</span></div>
      <h3>${esc(a.full_name)}</h3>
      <div class="muted">${esc(a.email)}</div>
      <div class="muted">AM: <b>${esc(a.am_name || '—')}</b>${a.manager_name ? ` · under OPS ${esc(a.manager_name)}` : ''}</div>
      <div class="muted">${applied}/${mine.length} applied</div>
    </div>`;
  }).join('') || '<p class="muted">No applicants match.</p>';
  $('dir-list').querySelectorAll('.ap-card').forEach((card) => {
    card.addEventListener('click', () => {
      state.selected = card.dataset.awl;
      drawDirectory(state, applicants, applications);
      drawQueue(state.selected, applications);
    });
  });
}

function drawQueue(awlId, applications) {
  const mine = applications.filter((a) => a.awl_id === awlId);
  const isCa = ME.role === 'ca';
  $('queue-pane').innerHTML = `<h3 style="margin:4px 0;">📋 Assigned Applications Queue — <span class="mono">${esc(awlId)}</span></h3>` +
    (mine.length ? mine.map((a) => queueCard(a, isCa)).join('') : '<p class="muted">No job links assigned yet.</p>');

  mine.forEach((a) => {
    const applyBtn = $(`apply-${a.id}`);
    if (applyBtn) applyBtn.addEventListener('click', async () => {
      try {
        await api(`/api/applications/${a.id}/apply`, { method: 'POST', body: JSON.stringify({}) });
        toast(`Application #${a.id} queued for automation.`);
        window.__awlRefreshTab();
      } catch (err) { toast(err.message, true); }
    });

    const reviewBtn = $(`review-toggle-${a.id}`);
    if (reviewBtn) reviewBtn.addEventListener('click', () => toggleReview(a));

    const skipBtn = $(`skip-${a.id}`);
    if (skipBtn) skipBtn.addEventListener('click', () => {
      const box = $(`reason-${a.id}`);
      box.classList.toggle('hidden');
      const confirm = $(`reason-confirm-${a.id}`);
      if (confirm && !confirm.dataset.bound) {
        confirm.dataset.bound = '1';
        confirm.addEventListener('click', async () => {
          const reason = $(`reason-input-${a.id}`).value.trim();
          if (!reason) return toast('A reason is required to skip.', true);
          try {
            await api(`/api/applications/${a.id}/skip`, { method: 'POST', body: JSON.stringify({ reason }) });
            toast(`Application #${a.id} skipped (FAILED with reason).`);
            window.__awlRefreshTab();
          } catch (err) { toast(err.message, true); }
        });
      }
    });
  });
}

// Evidence screenshots a run uploaded to Supabase Storage (stored as a JSON
// string on the application row): #1 pre-submit, #2 post-submit acknowledgement.
// Rendered as clickable thumbnails; when storage was unavailable the recorded
// reason is shown instead (we never keep the image locally).
function screenshotsHtml(a) {
  let shots = null;
  try { shots = a.screenshots_json ? JSON.parse(a.screenshots_json) : null; } catch { shots = null; }
  if (!shots) return '';
  const thumb = (label, url) => url
    ? `<a href="${esc(url)}" target="_blank" rel="noopener" title="Open ${label}">` +
      `<figure class="shot"><img src="${esc(url)}" alt="${esc(label)}" loading="lazy" /><figcaption>${esc(label)}</figcaption></figure></a>`
    : '';
  const both = thumb('Pre-submit', shots.pre_submit) + thumb('Acknowledgement', shots.acknowledgement);
  if (both) return `<div class="shots">${both}${shots.error ? `<span class="muted small">${esc(shots.error)}</span>` : ''}</div>`;
  if (shots.error) return `<div class="muted small">📷 screenshots: ${esc(shots.error)}</div>`;
  return '';
}

function queueCard(a, isCa) {
  const decided = a.status !== 'ASSIGNED';
  const reason = a.skip_reason || a.fail_reason;
  return `<div class="card queue-card">
    <div class="head">
      <b>${esc(a.company)}</b> — ${esc(a.title)} ${chip(a.status)}
      ${a.link_status !== 'valid' ? `<span class="chip FAILED">link ${esc(a.link_status)}</span>` : ''}
    </div>
    <div class="muted"><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.url)}</a></div>
    ${reason ? `<div class="muted">Reason: ${esc(reason)}</div>` : ''}
    ${a.run_id ? `<div class="muted mono">run ${esc(a.run_id)} · attempts ${a.attempts}</div>` : ''}
    ${screenshotsHtml(a)}
    ${isCa && !decided ? `
      <div class="actions">
        <button id="review-toggle-${a.id}">📝 Review answers</button>
        <button class="green" id="apply-${a.id}" disabled title="Open the review pane first">✔ APPLY for this applicant</button>
        <button class="danger" id="skip-${a.id}">✖ SKIP</button>
      </div>
      <div id="review-${a.id}" class="review-pane hidden"></div>
      <div class="reason-box hidden" id="reason-${a.id}">
        <input id="reason-input-${a.id}" placeholder="Reason for skipping (required)…" />
        <button id="reason-confirm-${a.id}">Confirm skip</button>
      </div>` : ''}
    ${isCa && decided ? `<div class="muted">Decision by CA on ${fmt(a.decision_at)}</div>` : ''}
  </div>`;
}

/* --------- pre-Apply CA review pane (answers + AI drafts + gaps) ------
   Rendered inside each ASSIGNED queue-card when the CA clicks "Review
   answers". Loads GET /answers; if the draft pass hasn't run yet, POST
   /answers/draft (browser-free, deterministic-first, GenAI for descriptive
   fields). Renders three sections - auto-filled / AI-drafted / needs input -
   and wires change events to POST /answers/edit so every edit is persisted
   immediately. APPLY is enabled only once blockers == 0 and the pane has
   been opened at least once. */
const REVIEW_STATE = new Map(); // appId -> { groups, blockers, scanned, loaded }
const SCAN_RETRY = new Map();   // appId -> auto-retry attempts while a scan runs

async function toggleReview(a) {
  const pane = $(`review-${a.id}`);
  if (!pane) return;
  if (!pane.classList.contains('hidden')) { pane.classList.add('hidden'); return; }
  pane.classList.remove('hidden');
  await loadReview(a);
}

// Fetch + render the review for an application. Safe to call again while the
// pane is open (that is how the pre-scan auto-refresh re-enters).
async function loadReview(a) {
  const pane = $(`review-${a.id}`);
  if (!pane) return;
  const st = REVIEW_STATE.get(a.id);
  if (st && st.loaded) { renderReviewPane(a.id, st); updateApplyGate(a.id, st.blockers, true); return; }
  pane.innerHTML = '<div class="muted">Loading draft…</div>';
  try {
    let data = await api(`/api/applications/${a.id}/answers`);
    const total = Object.values(data.groups).reduce((s, arr) => s + arr.length, 0);
    if (!data.scanned) { renderScanPending(a, data); return; }
    if (!total) {
      pane.innerHTML = '<div class="muted">Running pre-Apply draft pass (deterministic + AI)…</div>';
      data = await api(`/api/applications/${a.id}/answers/draft`, { method: 'POST' });
    }
    SCAN_RETRY.delete(a.id);
    const state = { loaded: true, scanned: true, groups: data.groups, blockers: data.blockers };
    REVIEW_STATE.set(a.id, state);
    renderReviewPane(a.id, state);
    updateApplyGate(a.id, state.blockers, true);
  } catch (err) {
    pane.innerHTML = `<div class="review-warn">Could not load answers: ${esc(err.message)}</div>`;
  }
}

/* The link has no question inventory yet, so there is nothing to review and
   nothing may be submitted. loaded:false keeps APPLY gated on every re-open
   (a cached "empty but loaded" pane must never unlock the button); a scan that
   the background queue is already running refreshes this pane by itself. */
function renderScanPending(a, data = {}) {
  const pane = $(`review-${a.id}`);
  if (!pane) return;
  REVIEW_STATE.set(a.id, { loaded: false, scanned: false, groups: { deterministic: [], genai: [], placeholder: [], missing_fact: [], ca_edited: [], needs_input: [], not_applicable: [], stale: [] }, blockers: 0 });
  updateApplyGate(a.id, 0, false);
  const state = data.scanState || 'unscanned';
  const scanning = state === 'pre_scanning';
  const canScan = ME && (ME.role === 'dev' || ME.role === 'admin');
  const headline = scanning
    ? '⏳ Pre-scan in progress — this job link is being opened now. This pane refreshes itself when the questions land.'
    : state === 'queued' ? '🕐 Pre-scan is queued — the background worker will open this link shortly, then answer what it can from the applicant profile.'
      : state === 'failed' ? '✗ The pre-scan of this link gave up after several attempts. A DEV can retry it from Data Sync.'
        : '⚠ This job link has no question inventory yet, so answers cannot be reviewed and APPLY stays locked.';
  pane.innerHTML = `
    <div class="review-warn">${headline}</div>
    ${canScan && !scanning ? `<div class="actions"><button id="scan-now-${a.id}">🔍 Pre-scan this link now</button><span class="muted small">hidden browser, once per link — every applicant on it reuses the result</span></div>` : ''}
    ${!canScan && !scanning && state !== 'queued' ? '<div class="muted small">A DEV/ADMIN can start or retry the pre-scan from the Data Sync tab.</div>' : ''}`;
  const btn = $(`scan-now-${a.id}`);
  if (btn) btn.addEventListener('click', async () => {
    btn.disabled = true;
    btn.textContent = 'Queueing…';
    try {
      await api('/api/dev/links/scan', { method: 'POST', body: { url: a.url } });
      renderScanPending(a, { scanState: 'pre_scanning' });
    } catch (err) {
      pane.innerHTML = `<div class="review-warn">Scan could not be queued: ${esc(err.message)}</div>`;
    }
  });
  // A queued or running scan is expected to land: keep re-opening the pane so the
  // CA sees the answered questions without touching anything. 'failed' does not.
  if (scanning || state === 'queued') scheduleScanRetry(a);
}

function scheduleScanRetry(a) {
  const n = (SCAN_RETRY.get(a.id) || 0) + 1;
  SCAN_RETRY.set(a.id, n);
  if (n > 40) {                                  // ~10 minutes, then hand it back
    const pane = $(`review-${a.id}`);
    if (pane && !pane.classList.contains('hidden')) {
      pane.innerHTML = '<div class="review-warn">Pre-scan is taking longer than usual. Hit Refresh to check it.</div>';
    }
    return;
  }
  setTimeout(() => {
    const pane = $(`review-${a.id}`);
    if (!pane || pane.classList.contains('hidden')) { SCAN_RETRY.delete(a.id); return; }
    loadReview(a);
  }, 15000);
}

function updateApplyGate(appId, blockers, loaded) {
  const btn = $(`apply-${appId}`);
  if (!btn) return;
  if (!loaded) { btn.disabled = true; btn.title = 'Open the review pane first'; return; }
  if (blockers > 0) { btn.disabled = true; btn.title = `${blockers} question(s) still need your input`; }
  else { btn.disabled = false; btn.title = ''; }
}

function renderReviewPane(appId, state) {
  const pane = $(`review-${appId}`);
  if (!pane) return;
  const g = state.groups || {};
  const det = [...(g.deterministic || []), ...(g.placeholder || [])];
  const ai = [...(g.genai || []), ...(g.ca_edited || [])];
  // "Needs your input" is every question the automation could NOT answer. That now
  // includes questions the form asks that no draft pass ever reached
  // (source = needs_input): they must be visible and typeable, never silently
  // dropped, or the CA is left staring at a locked APPLY with no reason.
  const allGaps = [...(g.missing_fact || []), ...(g.needs_input || [])];
  const gaps = allGaps.filter((r) => !r.optional);
  const optionalGaps = allGaps.filter((r) => r.optional);
  const openGaps = gaps.filter((r) => !r.value).length;
  const info = [...(g.not_applicable || []), ...(g.stale || [])];
  pane.innerHTML = `
    ${det.length ? `<details class="review-sec review-a"><summary>✓ Auto-filled from profile (${det.length}) — tap to review / edit</summary>${det.map((r) => fieldRow(appId, r, 'edit')).join('')}</details>` : ''}
    ${ai.length ? `<details class="review-sec review-b" open><summary>✍️ AI-drafted — please review (${ai.length})</summary>${ai.map((r) => fieldRow(appId, r, 'edit')).join('')}</details>` : ''}
    ${gaps.length ? `<details class="review-sec review-c" open><summary>❗ Needs your input (${openGaps})</summary>${gaps.map((r) => fieldRow(appId, r, 'required')).join('')}</details>` : ''}
    ${optionalGaps.length ? `<details class="review-sec review-o"><summary>◽ Optional (${optionalGaps.length}) — leave blank to skip</summary>${optionalGaps.map((r) => fieldRow(appId, r, 'optional')).join('')}</details>` : ''}
    ${info.length ? `<details class="review-sec review-i"><summary>ℹ Not a typed question (${info.length}) — upload / no longer on the form</summary>${info.map((r) => fieldRow(appId, r, 'readonly')).join('')}</details>` : ''}
    ${!det.length && !ai.length && !gaps.length && !optionalGaps.length && !info.length ? '<div class="muted">No fields resolved. Try re-running the scan + draft.</div>' : ''}`;
  pane.querySelectorAll('[data-field-key]').forEach((el) => {
    el.addEventListener('change', () => onAnswerEdit(appId, el));
  });
  pane.querySelectorAll('[data-na-for]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const key = btn.dataset.naFor;
      const el = pane.querySelector(`[data-field-key="${CSS.escape(key)}"]`);
      if (el) el.value = 'N/A';
      await onAnswerEdit(appId, { dataset: { fieldKey: key }, value: 'N/A' });
    });
  });
}

// Question label for the CA review: when a GenAI gist exists (long questions /
// option lists) show it as the headline and keep the full verbatim wording
// available on expand; otherwise show the question exactly as the form asks it.
function questionLabel(r) {
  const full = String(r.question_text || '');
  if (r.question_summary) {
    return `<b>${esc(r.question_summary)}</b>
      <details class="q-full"><summary class="muted small">as asked on the form</summary><div class="muted small">${esc(full)}</div></details>`;
  }
  return `<b>${esc(full)}</b>`;
}

function fieldRow(appId, r, mode) {
  const val = r.value == null ? '' : String(r.value);
  const key = esc(r.field_key);
  const dis = mode === 'readonly' ? 'readonly' : '';
  const badge = mode === 'readonly' ? `<span class="pill pill-a">${esc(r.source)}</span>`
    : mode === 'edit' ? `<span class="pill pill-b">${esc(r.source)}</span>`
    : mode === 'optional' ? `<span class="pill pill-o">optional</span>`
    : `<span class="pill pill-c">needs input</span>`;
  const ev = r.evidence && r.evidence.length ? `<div class="muted small">evidence: ${r.evidence.slice(0, 3).map(esc).join(' · ')}</div>` : '';
  // The control kind, exactly as the form has it, so the CA answers the question
  // the way it will be typed: dropdown choice vs free text vs paragraph.
  const kindTag = `<span class="pill pill-k" title="How the form asks it">${esc(r.field_type || 'text')}${r.required && mode !== 'readonly' ? ' *' : ''}</span>`;

  // Standalone checkbox (attestation / "I agree"): render a real tick-box with
  // the statement as its label, not a text field.
  if (r.field_type === 'checkbox' && !(r.options && r.options.length)) {
    const checked = /^(y|yes|true|1|on|agree|accept)/i.test(val) ? 'checked' : '';
    const cdis = mode === 'readonly' ? 'disabled' : '';
    return `<div class="review-field mode-${mode} check-row">
      <label class="check-line">
        <input type="checkbox" data-field-key="${key}" data-mode="${mode}" ${checked} ${cdis} />
        <span>${questionLabel(r)} ${badge} ${kindTag}</span>
      </label>
      ${ev}
    </div>`;
  }

  let tag;
  if (r.options && r.options.length) {
    // A long option list (race/ethnicity has 8+, and a scan can miss one) is
    // handed to the CA as type-then-select: the datalist filters as they type and
    // still accepts a value the scan never captured, which is exactly what the
    // submit engine replays - it types the text and picks the match on the form.
    // Short lists (Yes/No, 3 options) stay a plain dropdown: fewer misclicks.
    if (r.options.length > 6) {
      const dlId = `dl-${appId}-${key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
      const ro = mode === 'readonly';
      tag = `<input list="${dlId}" data-field-key="${key}" data-mode="${mode}" value="${esc(val)}" ${ro ? 'readonly' : ''} placeholder="Start typing to pick ${r.options.length} options\u2026" />`+
        `<datalist id="${dlId}">${r.options.map((o) => `<option value="${esc(o)}"></option>`).join('')}</datalist>`;
    } else {
      const opts = ['<option value="">— choose —</option>']
        .concat(r.options.map((o) => `<option ${String(o) === val ? 'selected' : ''} value="${esc(o)}">${esc(o)}</option>`));
      tag = `<select data-field-key="${key}" data-mode="${mode}" ${mode === 'readonly' ? 'disabled' : ''}>${opts.join('')}</select>`;
    }
  } else if (val.length > 80 || r.field_type === 'textarea') {
    tag = `<textarea data-field-key="${key}" data-mode="${mode}" ${dis}>${esc(val)}</textarea>`;
  } else {
    const t = r.field_type === 'number' ? 'number' : 'text';
    const ph = mode === 'required' ? 'Type an answer, or click Use N/A' : '';
    tag = `<input type="${t}" data-field-key="${key}" data-mode="${mode}" value="${esc(val)}" ${dis} placeholder="${esc(ph)}" />`;
  }
  const quickNa = (mode === 'required' || mode === 'optional') && !(r.options && r.options.length)
    ? `<button class="use-na" data-na-for="${key}" type="button">Use N/A</button>` : '';
  return `<div class="review-field mode-${mode}">
    <label>${questionLabel(r)} ${badge} ${kindTag}</label>
    ${tag}
    ${quickNa}
    ${ev}
  </div>`;
}

async function onAnswerEdit(appId, el) {
  const key = el.dataset.fieldKey;
  if (!key) return;
  const value = el.type === 'checkbox' ? (el.checked ? 'true' : '') : el.value;
  try {
    const res = await api(`/api/applications/${appId}/answers/edit`, { method: 'POST', body: JSON.stringify({ edits: { [key]: value } }) });
    const st = REVIEW_STATE.get(appId);
    if (st) { st.groups = res.groups; st.blockers = res.blockers; REVIEW_STATE.set(appId, st); }
    // Live-update the "needs your input" count in the section header without
    // a full re-render (that would lose focus on the field being edited).
    const sec = document.querySelector(`#review-${appId} .review-c summary`);
    if (sec) {
      const all = [...(res.groups.missing_fact || []), ...(res.groups.needs_input || [])];
      const open = all.filter((x) => !x.value && !x.optional).length;
      sec.textContent = `❗ Needs your input (${open})`;
    }
    updateApplyGate(appId, res.blockers, true);
  } catch (err) { toast(err.message, true); }
}

/* ----------------------------- activity ---------------------------- */

async function renderActivity() {
  const { events } = await api('/api/activity');
  $('view').innerHTML = `<div class="card activity"><ul>${events.length ? events.map((e) => `
    <li><b>${esc(e.type)}</b> ${e.awl_id ? `· <span class="mono">${esc(e.awl_id)}</span>` : ''}
      ${e.company ? `· ${esc(e.company)} — ${esc(e.title)}` : ''}
      · ${esc(e.actor_name || e.actor)} · <span class="muted">${fmt(e.ts)}</span></li>`).join('')
    : '<li>No activity yet.</li>'}</ul></div>`;
}

/* ------------------------------ OPS -------------------------------- */

async function renderOpsOverview() {
  const data = await api('/api/ops/overview');
  const casRows = data.cas.map((ca) => [
    `<b>${esc(ca.name)}</b><br><span class="muted mono">${esc(ca.email)}</span>`,
    ca.active ? 'ACTIVE' : 'INACTIVE',
    ca.applications,
    fmt(ca.lastSignIn)
  ]);
  $('view').innerHTML = `
    ${statsHtml(data.counters)}
    <h3>Career Associates under me (${data.cas.length})</h3>
    ${tableHtml(['CA', 'Status', 'Applications', 'Last sign-in'], casRows)}
    <h3 style="margin-top:22px;">Recent activity</h3>
    <div class="card activity"><ul>${data.events.slice(0, 12).map((e) => `
      <li><b>${esc(e.type)}</b> ${e.awl_id ? `· <span class="mono">${esc(e.awl_id)}</span>` : ''} · ${esc(e.actor_name || e.actor)} · <span class="muted">${fmt(e.ts)}</span></li>`).join('') || '<li>None yet.</li>'}</ul></div>`;
}

/* ---------------- OPS assignment pool (AWL-ID -> CA, quota-capped) --- */

async function renderOpsAssignments() {
  const { applicants, quota, cas } = await api('/api/ops/pool');
  const remaining = Math.max(0, quota.quota - quota.assigned);
  const overCap = quota.assigned >= quota.quota;
  $('view').innerHTML = `
    <div class="stat-grid" style="margin-bottom:14px;">
      <div class="stat ${overCap ? 'red' : 'green'}"><div class="label">Quota used</div><div class="value">${quota.assigned}/${quota.quota}</div></div>
      <div class="stat blue"><div class="label">Remaining</div><div class="value">${remaining}</div></div>
      <div class="stat yellow"><div class="label">Unassigned in pool</div><div class="value">${applicants.length}</div></div>
    </div>
    <p class="muted" style="margin:0 0 12px;">Applicants streamed from the DB that still need a CA. Pick a CA and assign — their job links materialise into that CA's queue. <b>Ask DEV to raise your quota if you hit the cap.</b></p>
    ${overCap ? '<div class="error-box">Applicant quota reached — no new assignments until DEV raises it.</div>' : ''}
    ${cas.length ? '' : '<div class="error-box">No CAs under you yet. Ask DEV to add some.</div>'}
    ${applicants.length
      ? tableHtml(['Applicant', 'AWL-ID', 'Email', 'Pending links', 'Assign to CA'], applicants.map((a) => [
          `<b>${esc(a.full_name)}</b>`,
          `<span class="mono">${esc(a.awl_id)}</span>`,
          esc(a.email || '—'),
          a.pending_links,
          cas.length
            ? `<div style="display:flex;gap:6px;align-items:center;flex-wrap:wrap;">
                 <select data-assign-ca="${esc(a.awl_id)}" ${overCap ? 'disabled' : ''}>${cas.map((c) => `<option value="${c.uuid}">${esc(c.name)}</option>`).join('')}</select>
                 <button class="primary" data-assign="${esc(a.awl_id)}" ${overCap ? 'disabled' : ''}>Assign</button>
               </div>`
            : '<span class="muted">no CAs</span>'
        ]))
      : '<p class="muted">Pool is empty — every applicant here already has a CA. New DB syncs will show up here.</p>'}`;

  $('view').querySelectorAll('button[data-assign]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const awlId = btn.dataset.assign;
      const caUuid = document.querySelector(`[data-assign-ca="${CSS.escape(awlId)}"]`).value;
      try {
        const res = await api('/api/ops/assign', { method: 'POST', body: JSON.stringify({ awlId, caUuid }) });
        toast(`Assigned ${awlId} → created ${res.applications_created} application(s).`);
        openTab('assignments');
      } catch (err) { toast(err.message, true); }
    });
  });
}

async function renderApplicationsTable() {
  const { applications } = await api('/api/ca/applications');
  $('view').innerHTML = `
    <div style="margin-bottom:10px;max-width:260px;">
      <select id="status-filter">
        <option value="">All statuses</option>
        ${['ASSIGNED', 'QUEUED', 'APPLYING', 'SUCCESS', 'PENDING', 'FAILED'].map((s) => `<option>${s}</option>`).join('')}
      </select>
    </div>
    <div id="apps-table"></div>`;
  const draw = (filter) => {
    const rows = applications.filter((a) => !filter || a.status === filter).map((a) => [
      a.id, `<span class="mono">${esc(a.awl_id)}</span>`, esc(a.full_name),
      `<b>${esc(a.company)}</b> — ${esc(a.title)}`,
      ME.role !== 'ca' ? esc(a.ca_name || '—') : 'me',
      chip(a.status),
      esc(a.skip_reason || a.fail_reason || '—'),
      fmt(a.updated_at)
    ]);
    $('apps-table').innerHTML = tableHtml(
      ['#', 'AWL-ID', 'Applicant', 'Job', ME.role === 'ca' ? '' : 'CA', 'Status', 'Reason', 'Updated'].filter(Boolean), rows);
  };
  draw('');
  $('status-filter').addEventListener('change', (e) => draw(e.target.value));
}

/* ------------------- OPS job-link assignment matrix ---------------- */

async function renderOpsLinks() {
  const [{ applications }, { cas }] = await Promise.all([
    api('/api/ca/applications'),
    api('/api/ops/team')
  ]);
  const STATUSES = ['ASSIGNED', 'QUEUED', 'APPLYING', 'SUCCESS', 'PENDING', 'FAILED'];
  if (!applications.length) { $('view').innerHTML = '<p class="muted">No job links assigned inside your tree yet.</p>'; return; }

  $('view').innerHTML = `
    <p class="muted" style="margin:0 0 12px;">Every job link assigned inside your tree — who owns it, where it stands, and your OPS overrides (change CA · force status).</p>
    ${tableHtml(['Job link', 'Applicant', 'Assigned CA', 'Status', 'Force status (OPS override)'], applications.map((a) => [
      `<b>${esc(a.company)}</b> — ${esc(a.title)}<br><a href="${esc(a.url)}" target="_blank" rel="noopener">${esc(a.url.slice(0, 55))}…</a>
       ${a.link_status !== 'valid' ? `<br><span class="chip FAILED">link ${esc(a.link_status)}</span>` : ''}`,
      `<span class="mono">${esc(a.awl_id)}</span><br>${esc(a.full_name)}`,
      cas.length
        ? `<select data-ca="${a.id}">${cas.map((c) => `<option value="${c.uuid}" ${c.uuid === a.ca_id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}${
            !cas.some((c) => c.uuid === a.ca_id) ? `<option disabled>current: ${esc(a.ca_name || 'unassigned')}</option>` : ''
          }</select>
          <label class="muted" style="font-size:11px;white-space:nowrap;display:block;margin-top:4px;">
            <input type="checkbox" data-move="${a.id}" style="width:auto;margin-right:4px;">move whole applicant</label>`
        : esc(a.ca_name || '—'),
      chip(a.status),
      `<div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
         <select data-force="${a.id}" style="max-width:120px;">${STATUSES.map((s) => `<option ${s === a.status ? 'selected' : ''}>${s}</option>`).join('')}</select>
         <input data-force-reason="${a.id}" placeholder="reason (required)…" style="flex:1;min-width:140px;" />
         <button class="primary" data-force-save="${a.id}">Force</button>
       </div>`
    ]))}`;

  $('view').querySelectorAll('select[data-ca]').forEach((sel) => {
    sel.addEventListener('change', async () => {
      const id = sel.dataset.ca;
      const move = sel.closest('td').querySelector('input[type=checkbox]')?.checked;
      try {
        await api(`/api/ops/applications/${id}/reassign`, { method: 'POST', body: JSON.stringify({ caUuid: sel.value, moveApplicant: !!move }) });
        toast(`Application #${id} reassigned${move ? ' (applicant moved too)' : ''}.`);
        openTab('links');
      } catch (err) { toast(err.message, true); openTab('links'); }
    });
  });

  $('view').querySelectorAll('[data-force-save]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const id = btn.dataset.forceSave;
      const status = document.querySelector(`[data-force="${id}"]`).value;
      const reason = document.querySelector(`[data-force-reason="${id}"]`).value.trim();
      if (!reason) return toast('A reason is required to force a status.', true);
      try {
        await api(`/api/ops/applications/${id}/force-status`, { method: 'POST', body: JSON.stringify({ status, reason }) });
        toast(`Application #${id} force-set to ${status}.`);
        openTab('links');
      } catch (err) { toast(err.message, true); }
    });
  });
}

/* ------------------- CA drill-down (OPS + DEV) --------------------- */

async function renderCaSummaryInto(pane, caUuid) {
  const d = await api(`/api/team/ca/${caUuid}`);
  const appRows = d.applications.map((a) => [
    a.id, `<span class="mono">${esc(a.awl_id)}</span>`, esc(a.full_name),
    `<b>${esc(a.company)}</b> — ${esc(a.title)}`,
    chip(a.status), esc(a.skip_reason || a.fail_reason || '—'), fmt(a.updated_at)
  ]);
  pane.innerHTML = `
    <div class="card" style="margin-bottom:14px;">
      <b>${esc(d.ca.name)}</b> <span class="chip role-ca">CA</span>
      ${d.ca.active ? '' : '<span class="chip FAILED">inactive</span>'}<br>
      <span class="muted mono">${esc(d.ca.email)}</span>
      <span class="muted"> · under OPS ${esc(d.ca.managerName || '—')} · last sign-in ${fmt(d.ca.lastSignIn)}</span>
    </div>
    ${statsHtml(d.counters)}
    <h3>Applicants (${d.applicants.length})</h3>
    ${tableHtml(['AWL-ID', 'Name', 'Email', 'AM', 'Jobs', 'Applied'], d.applicants.map((ap) => {
      const mine = d.applications.filter((x) => x.awl_id === ap.awl_id);
      return [`<span class="mono">${esc(ap.awl_id)}</span>`, esc(ap.full_name), esc(ap.email),
        esc(ap.am_name || '—'), ap.job_count, `${mine.filter((x) => x.status === 'SUCCESS').length}/${mine.length}`];
    }))}
    <h3 style="margin-top:20px;">Applications (${d.applications.length})</h3>
    ${tableHtml(['#', 'AWL-ID', 'Applicant', 'Job', 'Status', 'Reason', 'Updated'], appRows)}
    <h3 style="margin-top:20px;">Recent activity</h3>
    <div class="card activity"><ul>${d.events.map((e) => `
      <li><b>${esc(e.type)}</b> ${e.awl_id ? `· <span class="mono">${esc(e.awl_id)}</span>` : ''}
        ${e.company ? `· ${esc(e.company)} — ${esc(e.title)}` : ''} · <span class="muted">${fmt(e.ts)}</span></li>`).join('')
      || '<li>None yet.</li>'}</ul></div>`;
}

async function renderOpsCaView() {
  const { cas } = await api('/api/ops/team');
  if (!cas.length) { $('view').innerHTML = '<p class="muted">No CAs under you yet.</p>'; return; }
  $('view').innerHTML = `
    <h3 style="margin:4px 0 8px;">Pick a CA to see their workings</h3>
    <div style="max-width:340px;margin-bottom:14px;">
      <select id="ca-view-pick">${cas.map((c, i) => `<option value="${c.uuid}" ${i === 0 ? 'selected' : ''}>${esc(c.name)} — ${esc(c.email)}</option>`).join('')}</select>
    </div>
    <div id="ca-view-pane"><p class="muted">Loading…</p></div>`;
  const load = () => renderCaSummaryInto($('ca-view-pane'), $('ca-view-pick').value)
    .catch((err) => { $('ca-view-pane').innerHTML = `<div class="error-box">${esc(err.message)}</div>`; });
  $('ca-view-pick').addEventListener('change', load);
  load();
}

async function renderDevPeople() {
  const { ops } = await api('/api/public/ops');
  if (!ops.length) { $('view').innerHTML = '<p class="muted">No OPS managers exist yet.</p>'; return; }
  $('view').innerHTML = `
    <h3 style="margin:4px 0 8px;">Drill into any OPS tree, then any CA inside it</h3>
    <div style="display:flex;gap:10px;flex-wrap:wrap;max-width:720px;margin-bottom:14px;">
      <select id="people-ops" style="flex:1;">${ops.map((c, i) => `<option value="${c.uuid}" ${i === 0 ? 'selected' : ''}>OPS: ${esc(c.name)} — ${esc(c.email)}</option>`).join('')}</select>
      <select id="people-ca" style="flex:1;"></select>
    </div>
    <div id="people-ops-pane"></div>
    <h3 style="margin-top:20px;">Selected CA</h3>
    <div id="people-pane"><p class="muted">Pick a CA.</p></div>`;

  const loadCa = () => {
    const uuid = $('people-ca').value;
    if (!uuid) { $('people-pane').innerHTML = '<p class="muted">This OPS manager has no CAs yet.</p>'; return; }
    renderCaSummaryInto($('people-pane'), uuid)
      .catch((err) => { $('people-pane').innerHTML = `<div class="error-box">${esc(err.message)}</div>`; });
  };
  const loadOpsTree = async () => {
    const managerId = $('people-ops').value;
    const opsName = (ops.find((c) => c.uuid === managerId) || {}).name || 'OPS';
    // OPS-level overview (counters + their CAs) via the existing scoped endpoint
    const [data, team] = await Promise.all([
      api(`/api/ops/overview?managerId=${managerId}`),
      api(`/api/ops/team?managerId=${managerId}`)
    ]);
    $('people-ca').innerHTML = team.cas.length
      ? team.cas.map((c, i) => `<option value="${c.uuid}" ${i === 0 ? 'selected' : ''}>CA: ${esc(c.name)} — ${esc(c.email)}</option>`).join('')
      : '<option value="">— no CAs under this OPS manager —</option>';
    $('people-ops-pane').innerHTML = `
      <div class="card" style="margin-bottom:14px;">
        <b>${esc(opsName)}</b> <span class="chip role-ops">OPS</span><br><br>
        ${statsHtml(data.counters)}
        <span class="muted">${team.cas.length} CA(s) · ${data.applicants.length} applicant(s) · ${data.applications.length} application(s) in this tree</span>
      </div>`;
    loadCa();
  };
  $('people-ops').addEventListener('change', loadOpsTree);
  $('people-ca').addEventListener('change', loadCa);
  loadOpsTree();
}

/* ------------------------------ DEV -------------------------------- */

async function renderDevSystem() {
  const data = await api('/api/dev/overview');
  $('view').innerHTML = `
    ${statsHtml(data.counters)}
    <div class="stat-grid">
      ${Object.entries(data.system).map(([k, v]) => `
        <div class="stat green"><div class="label">${esc(k)}</div><div class="value" style="font-size:15px;">${esc(String(v))}</div></div>`).join('')}
    </div>
    <div class="card">
      <b>Worker engine</b>
      <p class="muted">The Playwright automation worker consumes QUEUED rows when enabled. Engine wiring lands in the next phase; this toggle proves the control path.</p>
      <button id="worker-toggle" class="${data.system.workerEnabled ? 'danger' : 'green'}">${data.system.workerEnabled ? '■ Stop worker' : '▶ Start worker'}</button>
    </div>`;
  $('worker-toggle').addEventListener('click', async () => {
    try {
      await api('/api/dev/worker', { method: 'POST', body: JSON.stringify({ enabled: !data.system.workerEnabled }) });
      openTab('system');
    } catch (err) { toast(err.message, true); }
  });
}

/* --------------- DEV data sync (Postgres / ingest / quota / worker) ---- */

/* Pre-scan worker card. The queue is durable (`link_scan_jobs`), so this is a
   view of DB rows + what this process is running right now, never a promise.
   Built as its own function: the card nests several templates, and doing that
   inline inside the page template is unreadable (and easy to mis-close). */
function preScanQueueCard(queue = {}) {
  const c = queue.counts || {};
  const pill = (label, n, cls) => `<span class="pill ${cls || ''}" style="margin-right:6px;">${label} <b>${n || 0}</b></span>`;
  const bits = [];
  bits.push(`<p style="margin:6px 0;">
    ${pill('pending', c.PENDING)}${pill('scanning', c.RUNNING)}${pill('done', c.DONE, 'green')}
    ${c.FAILED ? pill('failed', c.FAILED, 'red') : ''}
    <span class="muted small">· headless ${queue.headless === false ? 'OFF (visible window)' : 'ON'} · drafts pre-warmed ${queue.prewarm === false ? 'OFF' : 'ON'} · ${queue.maxConcurrent || 1} at a time</span>
  </p>`);
  if (queue.running?.length) {
    bits.push(`<p class="muted small">${queue.running.map((r) => `▶ <span class="mono">${esc(r.url)}</span> — ${r.seconds}s (job #${r.jobId})`).join('<br>')}</p>`);
  }
  if (queue.recent?.length) {
    bits.push(tableHtml(['link', 'state', 'tries', 'fields', 'took', 'last error / why'], queue.recent.map((j) => [
      `<span class="mono small">${esc(j.url)}</span>`,
      j.status === 'DONE' ? '<b>✓ scanned</b>' : j.status === 'FAILED' ? '<span class="pill">✗ failed</span>'
        : j.status === 'RUNNING' ? '⏳ scanning' : '🕐 queued',
      `${j.attempts}/${j.max_attempts}`,
      j.fields || '—',
      j.duration_ms ? `${Math.round(j.duration_ms / 1000)}s` : '—',
      `<span class="small" title="${esc(j.last_error || '')}">${esc(String(j.last_error || j.reason || '—').slice(0, 70))}</span>`
    ])));
  }
  const blocked = queue.unscanned?.length
    ? `<p class="muted small" style="margin-top:6px;">links with no question inventory yet: ${queue.unscanned.map((l) => `<div class="mono small">#${l.id} ${esc(l.company || '?')} — ${esc(l.url)}</div>`).join('')}</p>`
    : '';
  return `<div class="card" style="margin-bottom:14px;">
      <b>Pre-scan worker</b>
      <p class="muted">Every newly assigned link gets its questions scanned into
        <span class="mono">ashby_joblink_questions</span> by this background worker — one link, one scan,
        reused by every applicant on it. Intents survive a restart and retry with backoff
        (<span class="mono">link_scan_jobs</span>). Auto-scan is
        <b>${queue.enabled === false ? 'OFF (AUTO_SCAN_ON_LINK=false)' : 'ON'}</b>${queue.started === false ? ' — but this server has not started the loop' : ''}.</p>
      ${bits.join('')}
      <div class="actions">
        <button class="primary" id="btn-scan-backlog" ${queue.unscanned?.length ? '' : 'disabled'}>🔍 Pre-scan ${queue.unscanned?.length || 0} unscanned link(s)</button>
        <button id="btn-scan-retry" ${c.FAILED ? '' : 'disabled'}>↻ Retry ${c.FAILED || 0} failed link(s)</button>
        <button id="btn-scan-refresh">↻ Refresh</button>
      </div>
      ${blocked}
    </div>`;
}

async function renderDevDataSync() {
  const [data, cache, queue] = await Promise.all([
    api('/api/dev/overview'),
    api('/api/dev/joblinks').catch(() => ({ joblinks: [], configured: false, note: 'unreachable' })),
    api('/api/dev/scan-queue').catch(() => ({ counts: {}, running: [], recent: [], unscanned: [] }))
  ]);
  const opsStaff = data.staff.filter((s) => s.role === 'ops');
  const ws = data.system.worker || {};
  $('view').innerHTML = `
    <div class="card" style="margin-bottom:14px;">
      <b>Applicant DB connector</b>
      <p class="muted">${esc(data.system.connector)}. Configure PG_* env vars (Azure Postgres) then pull
        AWL-ID applicants into the local store. Resumes are never stored — only the S3 address.
        Job links are read from <span class="mono">ashby_joblinks</span> on every sync; the box below is the write side.</p>
      <div class="actions">
        <button class="primary" id="btn-pg-sync">⇅ Sync applicants from Postgres</button>
      </div>
      <div id="sync-out" class="muted" style="margin-top:8px;"></div>
    </div>

    <div class="card" style="margin-bottom:14px;">
      <b>Job links (AWL-ID → link)</b>
      <p class="muted">One pair per line — <span class="mono">AWL-123&nbsp;&nbsp;https://jobs.ashbyhq.com/…</span>
        (any spacing/order; # lines ignored). Each link is registered once in
        <span class="mono">ashby_joblink_questions</span> and its pre-scanned questions are reused for
        every applicant it is assigned to. A link that has no questions cached yet is
        <b>pre-scanned automatically</b> in the background the moment it is assigned.</p>
      <textarea id="links-paste" rows="5" style="width:100%;font-family:monospace;font-size:12px;"
        placeholder="AWL-101  https://jobs.ashbyhq.com/acme/4e64ab86-4e30-403b-b1b9-41dc052570ce&#10;AWL-102  https://jobs.ashbyhq.com/acme/4e64ab86-4e30-403b-b1b9-41dc052570ce"></textarea>
      <div class="actions"><button class="green" id="btn-add-links">⤑ Add job links</button></div>
      <div id="links-out" class="muted" style="margin-top:8px;"></div>
      <p class="muted" style="margin-top:10px;">ashby_joblinks (AWL-ID → links):
        ${tableHtml(['AWL-ID', 'job_links'], (cache.assignments || []).map((r) => [
          `<span class="mono">${esc(r.awl_id)}</span>`,
          r.job_links.map((u) => `<div class="small mono">${esc(u)}</div>`).join('') || '<span class="muted">—</span>'
        ])) || '<p class="muted">No assignments yet.</p>'}
      </p>
      <p class="muted" style="margin-top:10px;">ashby_joblink_questions (link → pre-scanned questions):
        ${tableHtml(['job_id', 'job_link', 'questions'], (cache.joblinks || []).map((r) => [
          `<span class="mono small">${esc(r.job_id)}</span>`,
          `<a href="${esc(r.job_link)}" target="_blank" rel="noopener">${esc(r.job_link)}</a>`,
          r.scanned ? `<b>${r.question_count}</b>` : '<span class="pill">not scanned</span>'
        ])) || '<p class="muted">No links registered yet.</p>'}
      </p>
    </div>

    ${preScanQueueCard(queue)}

    <div class="card" style="margin-bottom:14px;">
      <b>Ingest one applicant document (JSON)</b>
      <p class="muted">Paste the <span class="mono">{ client, additional_information }</span> export to load a single
        applicant now, without a live DB. Attach to an OPS manager so it lands in their assignment pool.</p>
      <div style="max-width:340px;margin-bottom:8px;">
        <select id="ingest-ops"><option value="">— shared pool (no OPS manager) —</option>
          ${opsStaff.map((c) => `<option value="${c.uuid}">${esc(c.name)} — ${esc(c.email)}</option>`).join('')}
        </select>
      </div>
      <textarea id="ingest-json" rows="8" style="width:100%;font-family:monospace;font-size:12px;"
        placeholder='{ "client": { "applywizz_id": "AWL-9999", "full_name": "..." }, "additional_information": { ... } }'></textarea>
      <div class="actions"><button class="green" id="btn-ingest">⤓ Ingest applicant</button></div>
      <div id="ingest-out" class="muted" style="margin-top:8px;"></div>
    </div>

    <div class="card" style="margin-bottom:14px;">
      <b>Per-OPS applicant quota</b>
      <p class="muted">How many applicants each OPS manager may hold. This is the cap “we” set.</p>
      ${tableHtml(['OPS', 'Email', 'Quota'], opsStaff.map((c) => [
        esc(c.name), `<span class="mono">${esc(c.email)}</span>`,
        `<div style="display:flex;gap:6px;align-items:center;">
           <input type="number" min="0" value="${c.applicantQuota ?? 25}" data-quota="${c.uuid}" style="width:90px;" />
           <button class="primary" data-quota-save="${c.uuid}">Set</button>
         </div>`
      ])) || '<p class="muted">No OPS managers yet.</p>'}
    </div>

    <div class="card">
      <b>Parallel automation worker</b>
      <p class="muted">Enabled: <b>${data.system.workerEnabled ? 'YES' : 'NO'}</b> ·
        active browsers: <b>${ws.active ?? 0}/${ws.maxConcurrent ?? 0}</b> ·
        engine: <span class="mono">${esc(ws.engine || '—')}</span></p>
      <div class="actions">
        <button class="green" id="btn-worker-on" ${data.system.workerEnabled ? 'disabled' : ''}>▶ Enable worker</button>
        <button class="danger" id="btn-worker-off" ${data.system.workerEnabled ? '' : 'disabled'}>■ Disable worker</button>
      </div>
    </div>`;

  $('btn-pg-sync').addEventListener('click', async () => {
    $('sync-out').textContent = 'Syncing…';
    try {
      const { sync } = await api('/api/dev/sync', { method: 'POST', body: JSON.stringify({}) });
      $('sync-out').textContent = `seen ${sync.seen} · created ${sync.created} · updated ${sync.updated} · links ${sync.links} · skipped ${sync.skipped}`;
      toast('Postgres sync complete.');
    } catch (err) { $('sync-out').textContent = ''; toast(err.message, true); }
  });

  $('btn-add-links').addEventListener('click', async () => {
    const text = $('links-paste').value.trim();
    if (!text) return toast('Paste at least one "AWL-ID  <job link>" line.', true);
    $('btn-add-links').disabled = true;
    $('links-out').textContent = 'Saving…';
    try {
      const res = await api('/api/dev/links', { method: 'POST', body: JSON.stringify({ text }) });
      const bits = [];
      if (res.accepted?.length) bits.push(`queued ${res.accepted.length} pair(s)`);
      if (res.rejected?.length) bits.push(`rejected ${res.rejected.length}: ${res.rejected.map((r) => `${r.awlId} — ${r.error}`).join('; ')}`);
      $('links-out').innerHTML = `<b>${esc(bits.join(' · '))}</b>`
        + (res.scan?.queued?.length
          ? `<br>Pre-scan started in the background for ${res.scan.queued.length} link(s) — the CA review pane unlocks itself when the questions land.`
          : '<br>All links already have a cached question inventory.');
      $('links-paste').value = '';
      toast('Job links saved.');
      renderDevDataSync();          // refresh both tables underneath
    } catch (err) { $('links-out').textContent = ''; toast(err.message, true); }
    $('btn-add-links').disabled = false;
  });

  $('btn-ingest').addEventListener('click', async () => {
    let doc;
    try { doc = JSON.parse($('ingest-json').value); }
    catch { return toast('Invalid JSON in the textarea.', true); }
    try {
      const { ingest } = await api('/api/dev/ingest', { method: 'POST', body: JSON.stringify({ doc, opsId: $('ingest-ops').value || null }) });
      $('ingest-out').textContent = `Ingested ${ingest.created ? 'new applicant' : 'updated'} with ${ingest.links} job link(s).`;
      toast('Applicant ingested into the pool.');
    } catch (err) { toast(err.message, true); }
  });

  $('view').querySelectorAll('button[data-quota-save]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const uuid = btn.dataset.quotaSave;
      const quota = Number(document.querySelector(`[data-quota="${uuid}"]`).value) || 0;
      try {
        await api(`/api/dev/staff/${uuid}/quota`, { method: 'POST', body: JSON.stringify({ quota }) });
        toast('Quota updated.');
      } catch (err) { toast(err.message, true); }
    });
  });

  $('btn-worker-on').addEventListener('click', () => setWorker(true));
  $('btn-worker-off').addEventListener('click', () => setWorker(false));
  $('btn-scan-backlog')?.addEventListener('click', async () => {
    try {
      await api('/api/dev/links/scan', { method: 'POST', body: JSON.stringify({ all: true }) });
      toast('Pre-scan queued — the background worker opens a hidden browser per link.');
      renderDevDataSync();
    } catch (err) { toast(err.message, true); }
  });
  $('btn-scan-retry')?.addEventListener('click', async () => {
    try {
      const { requeued } = await api('/api/dev/links/scan', { method: 'POST', body: JSON.stringify({ retry: true }) });
      toast(`Re-queued ${requeued} failed link(s) for scanning.`);
      renderDevDataSync();
    } catch (err) { toast(err.message, true); }
  });
  $('btn-scan-refresh')?.addEventListener('click', () => renderDevDataSync());
  async function setWorker(enabled) {
    try {
      await api('/api/dev/worker', { method: 'POST', body: JSON.stringify({ enabled }) });
      toast(enabled ? 'Worker enabled — claiming QUEUED runs.' : 'Worker disabled.');
      openTab('datasync');
    } catch (err) { toast(err.message, true); }
  }
}

async function renderDevQueue() {
  const { queued } = await api('/api/dev/overview');
  if (!queued.length) { $('view').innerHTML = '<p class="muted">Queue is empty — nothing QUEUED / APPLYING / PENDING.</p>'; return; }
  $('view').innerHTML = queued.map((a) => `
    <div class="card queue-card">
      <div class="head">#${a.id} <span class="mono">${esc(a.awl_id)}</span> — ${esc(a.full_name)} ·
        <b>${esc(a.company)}</b> — ${esc(a.title)} ${chip(a.status)}</div>
      <div class="muted">CA ${esc(a.ca_name || '—')} · run ${esc(a.run_id || '—')} · attempts ${a.attempts} · queued ${fmt(a.queued_at)}</div>
      <div class="actions">
        ${a.status === 'FAILED' ? `<button data-act="requeue" data-id="${a.id}">↻ Re-queue</button>` : ''}
        ${a.status === 'PENDING' ? `<button class="green" data-act="resolve-success" data-id="${a.id}">Mark SUCCESS</button>
          <button class="danger" data-act="resolve-fail" data-id="${a.id}">Mark FAILED</button>` : ''}
        ${['QUEUED', 'APPLYING'].includes(a.status) ? `<button class="danger" data-act="force-fail" data-id="${a.id}">Force FAIL</button>` : ''}
      </div>
    </div>`).join('');

  $('view').querySelectorAll('button[data-act]').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const { id, act } = btn.dataset;
      try {
        if (act === 'requeue') await api(`/api/dev/applications/${id}/requeue`, { method: 'POST' });
        if (act === 'force-fail') await api(`/api/dev/applications/${id}/force-fail`, { method: 'POST', body: JSON.stringify({ reason: 'Force-failed by DEV' }) });
        if (act === 'resolve-success') await api(`/api/dev/applications/${id}/resolve`, { method: 'POST', body: JSON.stringify({ outcome: 'SUCCESS' }) });
        if (act === 'resolve-fail') await api(`/api/dev/applications/${id}/resolve`, { method: 'POST', body: JSON.stringify({ outcome: 'FAILED' }) });
        toast(`Application #${id} updated.`);
        openTab('queue');
      } catch (err) { toast(err.message, true); }
    });
  });
}

async function renderDevStaff() {
  const data = await api('/api/dev/overview');
  const opsStaff = data.staff.filter((s) => s.role === 'ops');
  const isAdmin = ME.role === 'admin';
  const ROLES = ['ca', 'ops', 'dev', 'admin'];
  const opsManagerName = (u) => { const c = opsStaff.find((x) => x.uuid === u); return c ? c.name : '— none —'; };

  const headers = ['Name', 'Email', 'Role', 'Under OPS', 'Active', 'Last sign-in'];
  if (isAdmin) headers.push('Change role (ADMIN)', 'Remove from org (ADMIN)');

  const rows = data.staff.map((s) => {
    const base = [
      esc(s.name), `<span class="mono">${esc(s.email)}</span>`,
      `<span class="chip role-${s.role}">${s.role.toUpperCase()}</span>`,
      s.role === 'ca'
        ? `<div style="min-width:220px;">
             <select data-staff="${s.uuid}">
               <option value="">— none —</option>
               ${opsStaff.map((c) => `<option value="${c.uuid}" ${s.managerId === c.uuid ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
             </select>
             <div class="muted" style="font-size:11px;margin-top:2px;">Current OPS: <b>${esc(opsManagerName(s.managerId))}</b></div>
             <div class="ops-pending hidden" data-pending="${s.uuid}" style="margin-top:6px;padding:6px 8px;border:1.5px dashed #b45309;border-radius:8px;font-size:12px;background:#fff7e6;color:#92400e;">
               <label style="display:flex;gap:6px;align-items:center;cursor:pointer;white-space:normal;">
                 <input type="checkbox" data-confirm="${s.uuid}" style="width:auto;" />
                 <span>⚠ Change OPS manager: <b>${esc(opsManagerName(s.managerId))}</b> → <b class="to-ops"></b></span>
               </label>
               <div class="actions" style="margin-top:6px;">
                 <button class="primary" data-save="${s.uuid}" disabled>Save change</button>
                 <button data-revert="${s.uuid}">Revert</button>
               </div>
             </div>
           </div>`
        : '—',
      s.active ? 'YES' : 'NO',
      fmt(s.lastSignIn)
    ];
    if (!isAdmin) return base;
    base.push(
      `<div style="min-width:200px;">
         <select data-role-sel="${s.uuid}">${ROLES.map((r) => `<option value="${r}" ${r === s.role ? 'selected' : ''}>${r.toUpperCase()}</option>`).join('')}</select>
         <div class="ops-pending hidden" data-role-pending="${s.uuid}" style="margin-top:6px;padding:6px 8px;border:1.5px dashed #b45309;border-radius:8px;font-size:12px;background:#fff7e6;color:#92400e;">
           <label style="display:flex;gap:6px;align-items:center;cursor:pointer;white-space:normal;">
             <input type="checkbox" data-role-confirm="${s.uuid}" style="width:auto;" />
             <span>⚠ Change role: <b>${s.role.toUpperCase()}</b> → <b class="to-role"></b></span>
           </label>
           <div class="actions" style="margin-top:6px;">
             <button class="primary" data-role-save="${s.uuid}" disabled>Save role</button>
             <button data-role-revert="${s.uuid}">Revert</button>
           </div>
         </div>
       </div>`,
      s.uuid === ME.uuid
        ? '<span class="muted">— (yourself) —</span>'
        : `<div style="min-width:210px;">
             <button class="danger" data-del="${s.uuid}">🗑 Remove…</button>
             <div data-del-box="${s.uuid}" class="hidden" style="margin-top:6px;padding:8px;border:1.5px solid var(--coral);border-radius:8px;background:var(--coral-soft);font-size:12px;color:#7a1f14;"></div>
           </div>`
    );
    return base;
  });

  $('view').innerHTML = `
    <p class="muted" style="margin:0 0 12px;">${isAdmin
      ? 'As <b>ADMIN</b> you can move a CA between OPS managers, change any member’s role, and permanently remove a member from the organisation. Every destructive action is confirm-gated — nothing happens until you tick the box.'
      : 'To move a CA to a different OPS manager: pick the new OPS in the dropdown, tick <b>Confirm change</b>, then Save. Nothing is saved until you confirm — pick the same OPS back (or Revert) to cancel.'}</p>
    ${tableHtml(headers, rows)}`;

  /* ---- OPS reassignment (DEV + ADMIN): confirm-gated ---- */
  $('view').querySelectorAll('select[data-staff]').forEach((sel) => {
    const uuid = sel.dataset.staff;
    const original = sel.value;
    const pending = document.querySelector(`[data-pending="${uuid}"]`);
    const confirm = document.querySelector(`[data-confirm="${uuid}"]`);
    const save = document.querySelector(`[data-save="${uuid}"]`);
    const revert = document.querySelector(`[data-revert="${uuid}"]`);
    const toEl = pending.querySelector('.to-ops');
    const reset = () => { pending.classList.add('hidden'); confirm.checked = false; save.disabled = true; };
    sel.addEventListener('change', () => {
      if (sel.value === original) return reset();
      toEl.textContent = sel.options[sel.selectedIndex].text;
      pending.classList.remove('hidden');
      confirm.checked = false;
      save.disabled = true;
    });
    confirm.addEventListener('change', () => { save.disabled = !confirm.checked; });
    revert.addEventListener('click', () => { sel.value = original; reset(); });
    save.addEventListener('click', async () => {
      try {
        await api(`/api/dev/staff/${uuid}/manager`, { method: 'POST', body: JSON.stringify({ managerId: sel.value || null }) });
        toast(`OPS manager changed: ${opsManagerName(original)} → ${opsManagerName(sel.value)}.`);
        renderDevStaff();
      } catch (err) {
        toast(err.message, true);
        sel.value = original;
        reset();
      }
    });
  });

  if (!isAdmin) return;

  /* ---- ROLE change (ADMIN only): confirm-gated ---- */
  $('view').querySelectorAll('select[data-role-sel]').forEach((sel) => {
    const uuid = sel.dataset.roleSel;
    const original = sel.value;
    const pending = document.querySelector(`[data-role-pending="${uuid}"]`);
    const confirm = document.querySelector(`[data-role-confirm="${uuid}"]`);
    const save = document.querySelector(`[data-role-save="${uuid}"]`);
    const revert = document.querySelector(`[data-role-revert="${uuid}"]`);
    const toEl = pending.querySelector('.to-role');
    const reset = () => { pending.classList.add('hidden'); confirm.checked = false; save.disabled = true; };
    sel.addEventListener('change', () => {
      if (sel.value === original) return reset();
      toEl.textContent = sel.value.toUpperCase();
      pending.classList.remove('hidden');
      confirm.checked = false;
      save.disabled = true;
    });
    confirm.addEventListener('change', () => { save.disabled = !confirm.checked; });
    revert.addEventListener('click', () => { sel.value = original; reset(); });
    save.addEventListener('click', async () => {
      try {
        await api(`/api/admin/staff/${uuid}/role`, { method: 'POST', body: JSON.stringify({ role: sel.value }) });
        toast(`Role changed: ${original.toUpperCase()} → ${sel.value.toUpperCase()}.`);
        renderDevStaff();
      } catch (err) {
        toast(err.message, true);
        sel.value = original;
        reset();
      }
    });
  });

  /* ---- REMOVAL (ADMIN only): impact preview + reassign + typed confirm ---- */
  $('view').querySelectorAll('button[data-del]').forEach((btn) => {
    btn.addEventListener('click', () => openRemovalConfirm(btn.dataset.del));
  });

  async function openRemovalConfirm(uuid) {
    const box = document.querySelector(`[data-del-box="${uuid}"]`);
    if (!box.classList.contains('hidden')) { box.classList.add('hidden'); return; }
    box.classList.remove('hidden');
    box.innerHTML = '<span class="muted">Loading impact…</span>';
    let info;
    try { info = await api(`/api/admin/staff/${uuid}/impact`); }
    catch (err) { box.textContent = err.message; return; }
    const { target, impact, peers } = info;
    const blocking = impact.applicants + impact.activeApplications + impact.subordinateCas;
    const peerOpts = peers.map((p) => `<option value="${p.uuid}">${esc(p.name)} — ${esc(p.email)}</option>`).join('');
    box.innerHTML = `
      <div><b>Remove ${esc(target.name)}</b> <span class="chip role-${target.role}">${target.role.toUpperCase()}</span></div>
      <div class="muted" style="margin:4px 0;">${impact.applicants} applicant(s) · ${impact.activeApplications} active app(s) · ${impact.subordinateCas} subordinate CA(s) · ${impact.historyApplications} total application(s)</div>
      ${blocking > 0
        ? (peers.length
            ? `<div style="margin:6px 0;">They still own work — pick a <b>${target.role.toUpperCase()}</b> to inherit it:<br>
                 <select id="reassign-${uuid}" style="margin-top:4px;max-width:100%;"><option value="">— none (removal will be blocked) —</option>${peerOpts}</select></div>`
            : `<div style="margin:6px 0;font-weight:700;">Blocked: they own work and no other ${target.role.toUpperCase()} exists to inherit it. Move their applicants/apps first.</div>`)
        : '<div class="muted" style="margin:6px 0;">No owned work — safe to remove. Their account, sessions and dashboard access are deleted; historical applications remain for audit.</div>'}
      <label style="display:flex;gap:6px;align-items:flex-start;cursor:pointer;margin:6px 0;">
        <input type="checkbox" id="del-confirm-${uuid}" style="width:auto;margin-top:2px;" />
        <span>I understand this permanently removes ${esc(target.name)} from the organisation and dashboard.</span>
      </label>
      <div class="actions">
        <button class="danger" id="del-go-${uuid}" disabled>Confirm remove</button>
        <button id="del-cancel-${uuid}">Cancel</button>
      </div>`;
    const blocked = blocking > 0 && !peers.length;
    const chk = $(`del-confirm-${uuid}`);
    const go = $(`del-go-${uuid}`);
    chk.addEventListener('change', () => { go.disabled = !chk.checked || blocked; });
    $(`del-cancel-${uuid}`).addEventListener('click', () => box.classList.add('hidden'));
    go.addEventListener('click', async () => {
      const reassignSel = document.querySelector(`select[id="reassign-${uuid}"]`);
      const reassignTo = blocking > 0 ? (reassignSel ? reassignSel.value : null) : null;
      if (blocking > 0 && !reassignTo) return toast('Pick who inherits their work first.', true);
      try {
        await api(`/api/admin/staff/${uuid}`, { method: 'DELETE', body: JSON.stringify({ reassignTo }) });
        toast(`${target.name} removed from the organisation.`);
        renderDevStaff();
      } catch (err) { toast(err.message, true); box.textContent = err.message; }
    });
  }
}

/* The DEV activity feed. Every stage of the pipeline writes an event, and the
   prefixes below are what the server can filter on (type = event-name prefix),
   so a DEV can watch one stage instead of scrolling the whole log. */
const EVENT_STAGES = [
  ['', 'All activity'],
  ['applicant_profile', 'CRM profile fetch / re-fetch'],
  ['links_ingested', 'Job links pasted (AWL-ID → link)'],
  ['link_scan', 'Pre-scan worker (queue → scan → done/retry)'],
  ['link_inventory', 'Shared question-cache restore'],
  ['draft_pass', 'Auto-fill draft pass (deterministic + AI)'],
  ['ca_answers', 'CA field edits in the review pane'],
  ['apply_blocked', 'APPLY attempts that stayed locked'],
  ['application.', 'Decisions: apply / skip / transitions'],
  ['applicant_assigned', 'OPS assignments'],
  ['run_', 'Automation runs (start + outcome)'],
  ['screenshots', 'Submit screenshots → S3'],
  ['crm_writeback', 'Write-back to the CRM'],
  ['applicant_data', 'Post-success privacy purge'],
  ['external_', 'Connector syncs / ingests'],
  ['staff', 'Staff & auth changes']
];

let EVENTS_TIMER = null;
let EVENTS_AUTO = false;          // survives the re-render (the checkbox is rebuilt each time)

async function renderDevEvents() {
  const params = new URLSearchParams(window.location.search);
  const stage = params.get('stage') || '';
  const { events } = await api(`/api/dev/events?limit=300${stage ? `&type=${encodeURIComponent(stage)}` : ''}`);
  $('view').innerHTML = `
    <div class="card" style="margin-bottom:12px;">
      <div style="display:flex;gap:10px;align-items:center;flex-wrap:wrap;">
        <select id="ev-stage" style="max-width:320px;">
          ${EVENT_STAGES.map(([v, l]) => `<option value="${esc(v)}" ${v === stage ? 'selected' : ''}>${esc(l)}</option>`).join('')}
        </select>
        <label style="display:flex;gap:6px;align-items:center;cursor:pointer;">
          <input type="checkbox" id="ev-auto" style="width:auto;" ${EVENTS_AUTO ? 'checked' : ''} /> auto-refresh 10s
        </label>
        <span class="muted small">${events.length} most recent event(s)${stage ? ` — matching “${esc(stage)}*”` : ''} · hover a payload for the full blob</span>
      </div>
    </div>
    ${tableHtml(
      ['When', 'Type', 'App #', 'AWL-ID', 'Company / Job', 'Actor', 'Payload'],
      events.map((e) => [
        `<span class="small">${fmt(e.ts)}</span>`,
        `<b>${esc(e.type)}</b>`,
        e.application_id ?? '—',
        `<span class="mono">${esc(e.awl_id || '—')}</span>`,
        e.company ? `${esc(e.company)} — ${esc(e.title)}` : '—',
        esc(e.actor_name || e.actor || '—'),
        `<span class="mono small" title="${esc(e.payload_json || '')}">${esc(prettyPayload(e.payload_json))}</span>`
      ])
    )}`;
  $('ev-stage').addEventListener('change', () => {
    const q = $('ev-stage').value;
    const url = q ? `${window.location.pathname}?stage=${encodeURIComponent(q)}` : window.location.pathname;
    history.replaceState(null, '', url);
    renderDevEvents();
  });
  $('ev-auto').addEventListener('change', (ev) => {
    EVENTS_AUTO = ev.target.checked;
    if (EVENTS_TIMER) { clearInterval(EVENTS_TIMER); EVENTS_TIMER = null; }
    if (EVENTS_AUTO) {
      EVENTS_TIMER = setInterval(() => {
        // Self-guarding: the moment another tab is open, this feed stops polling.
        if (ACTIVE_TAB !== 'events') { clearInterval(EVENTS_TIMER); EVENTS_TIMER = null; return; }
        renderDevEvents().catch(() => { /* transient */ });
      }, 10000);
    }
  });
}

// Payloads are JSON strings; show the keys that matter on one line and keep the
// complete blob in the row's tooltip.
function prettyPayload(raw) {
  const s = String(raw || '').trim();
  if (!s) return '—';
  try {
    const o = JSON.parse(s);
    return Object.entries(o).filter(([, v]) => v !== null && v !== undefined && v !== '')
      .map(([k, v]) => `${k}=${typeof v === 'object' ? JSON.stringify(v) : v}`)
      .join(' · ')
      .slice(0, 180) || s.slice(0, 180);
  } catch { return s.slice(0, 180); }
}

async function renderDevTables() {
  const names = ['link_scan_jobs', 'staff', 'ams', 'job_links', 'applicants', 'applicant_joblinks', 'applications', 'application_events', 'sessions', 'system_state', 'job_link_fields', 'applicant_field_answers', 'automation_runs'];
  $('view').innerHTML = `
    <div style="max-width:280px;margin-bottom:12px;">
      <select id="table-pick">${names.map((n) => `<option>${n}</option>`).join('')}</select>
    </div>
    <div id="table-out" class="muted">Pick a table to inspect.</div>`;
  const load = async (name) => {
    const { rows } = await api(`/api/dev/table/${name}?limit=100`);
    if (!rows.length) { $('table-out').innerHTML = '<p class="muted">Empty table.</p>'; return; }
    const keys = Object.keys(rows[0]);
    $('table-out').innerHTML = tableHtml(keys, rows.map((r) => keys.map((k) => `<span class="mono">${esc(String(r[k] ?? '—').slice(0, 80))}</span>`)));
  };
  $('table-pick').addEventListener('change', (e) => load(e.target.value));
  load(names[0]);
  $('table-pick').dispatchEvent(new Event('change'));
}

boot();
