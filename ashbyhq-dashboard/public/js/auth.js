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

// ------------------------------- sign in ----------------------------------
// One email box, one button. There is no code and no sign-in/sign-up split: the
// server resolves the role from the address (fixed admins/dev, a rostered member,
// or the external staff roster for a brand-new email).

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

$('btn-send-code').addEventListener('click', async () => {
  const email = $('email').value.trim();
  if (!email) return showMsg($('identity-msg'), 'Enter your email first.');
  $('btn-send-code').disabled = true;
  showMsg($('identity-msg'), '');
  try {
    const out = await api('/api/auth/request-code', { method: 'POST', body: JSON.stringify({ email }) });
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
    // A 403 means this address is not on the approved roster; a 503 means the
    // roster API is unreachable for a NEW address. The server message says which.
    showMsg($('identity-msg'), err.message);
  } finally {
    $('btn-send-code').disabled = false;
  }
});
