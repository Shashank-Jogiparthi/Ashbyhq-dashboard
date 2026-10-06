const $ = (id) => document.getElementById(id);

async function api(path, options = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
    ...options
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

const HTML_ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
// The character class is written with \u escapes so no editor can "helpfully"
// swap a straight quote for a curly one and silently break the escaping.
const esc = (v) => String(v ?? '').replace(/[\u0026\u003c\u003e\u0022\u0027]/g, (c) => HTML_ESCAPES[c]);

// Everything routed through here is escaped first: error text comes back from
// the server, so it is never trusted as markup.
function showMsg(el, text, isError = true) {
  el.innerHTML = text ? `<div class="${isError ? 'error-box' : 'ok-box'}">${esc(text)}</div>` : '';
}

// ------------------------- sign in / sign up modes --------------------------
// The server takes the intent from `mode`, so the panel only ever shows the
// fields that mode can use: sign in is email-only, sign up adds the role.
let mode = 'signin';

const MODE_HINT = {
  signin: 'Already a member — email only.',
  signup: 'New staff account — choosing CA / OM / DEV below is mandatory. Your display name is taken from the email address.'
};

function setMode(next) {
  mode = next === 'signup' ? 'signup' : 'signin';
  const signup = mode === 'signup';
  $('tab-in').classList.toggle('active', !signup);
  $('tab-up').classList.toggle('active', signup);
  $('tab-in').setAttribute('aria-selected', String(!signup));
  $('tab-up').setAttribute('aria-selected', String(signup));
  $('signup-fields').classList.toggle('hidden', !signup);
  $('mode-hint').textContent = MODE_HINT[mode];
  $('btn-send-code').textContent = signup ? 'Create account & sign in →' : 'Sign in →';
  showMsg($('identity-msg'), '');
}

$('tab-in').addEventListener('click', () => setMode('signin'));
$('tab-up').addEventListener('click', () => setMode('signup'));
setMode('signin');

// Already signed in? Go straight to the dashboard.
(async () => {
  const token = localStorage.getItem('awl_token');
  if (!token) return;
  try {
    await api('/api/me', { headers: { Authorization: `Bearer ${token}` } });
    location.href = '/dashboard.html';
  } catch {
    localStorage.removeItem('awl_token');
  }
})();

// Load OM-manager list for the sign-up dropdown (role = CA only).
(async () => {
  try {
    const { ops } = await api('/api/public/ops');
    const select = $('ops');
    select.innerHTML = ops.length
      ? ops.map((c) => `<option value="${c.uuid}">${c.name} (${c.email})</option>`).join('')
      : '<option value="">— no OPS managers exist yet —</option>';
  } catch { /* non-fatal */ }
})();

$('role').addEventListener('change', () => {
  $('ops-field').classList.toggle('hidden', $('role').value !== 'ca');
});

$('btn-send-code').addEventListener('click', async () => {
  const email = $('email').value.trim();
  if (!email) return showMsg($('identity-msg'), 'Enter your email first.');
  $('btn-send-code').disabled = true;
  showMsg($('identity-msg'), '');
  try {
    const body = { email, mode };
    if (mode === 'signup') {
      body.role = $('role').value;
      if (body.role === 'ca' && $('ops').value) body.managerId = $('ops').value;
    }
    const out = await api('/api/auth/request-code', { method: 'POST', body: JSON.stringify(body) });
    // PASSWORDLESS: the server mints the session on this one call, so the user
    // goes straight to their dashboard — there is no code to send and none to enter.
    if (out.authenticated && out.token) {
      localStorage.setItem('awl_token', out.token);
      location.href = '/dashboard.html';
      return;
    }
    // Anything else is a broken/incomplete response: surface it rather than
    // silently doing nothing. There is intentionally no code step to fall back to.
    showMsg($('identity-msg'), 'Sign-in did not complete. Please try again.');
  } catch (err) {
    // Two failures are "you meant the other tab": move the panel there, then put
    // the server's explanation back (setMode clears the message box).
    const wants = /switch to "sign (up|in)"/i.exec(err.message);
    if (wants) setMode(wants[1].toLowerCase() === 'up' ? 'signup' : 'signin');
    showMsg($('identity-msg'), err.message);
  } finally {
    $('btn-send-code').disabled = false;
  }
});
