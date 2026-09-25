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

function showMsg(el, text, isError = true) {
  el.innerHTML = text ? `<div class="${isError ? 'error-box' : 'ok-box'}">${text}</div>` : '';
}

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

// Load OPS-manager list + toggle the OPS dropdown when role = CA.
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
    const body = { email };
    const name = $('name').value.trim();
    if (name) body.name = name;
    if ($('role').value === 'ca' && !$('ops-field').classList.contains('hidden')) {
      body.role = 'ca';
      if ($('ops').value) body.managerId = $('ops').value;
    } else {
      body.role = $('role').value;
    }
    const out = await api('/api/auth/request-code', { method: 'POST', body: JSON.stringify(body) });
    $('sent-to').textContent = out.email;
    $('new-account-note').textContent = out.isNewAccount
      ? 'New account created — check the server console for the code.'
      : `Existing ${String(out.role).toUpperCase()} account — the role is fixed at sign-up; the dropdown does not change it. Check the server console for the code.`;
    $('step-identity').classList.add('hidden');
    $('step-code').classList.remove('hidden');
    $('code').focus();
  } catch (err) {
    showMsg($('identity-msg'), err.message);
  } finally {
    $('btn-send-code').disabled = false;
  }
});

$('btn-back').addEventListener('click', () => {
  $('step-code').classList.add('hidden');
  $('step-identity').classList.remove('hidden');
  showMsg($('code-msg'), '');
});

$('btn-verify').addEventListener('click', verify);
$('code').addEventListener('keydown', (e) => { if (e.key === 'Enter') verify(); });

async function verify() {
  const code = $('code').value.trim();
  if (code.length !== 6) return showMsg($('code-msg'), 'Enter the full 6-digit code.');
  $('btn-verify').disabled = true;
  try {
    const out = await api('/api/auth/verify-code', {
      method: 'POST',
      body: JSON.stringify({ email: $('email').value.trim(), code })
    });
    localStorage.setItem('awl_token', out.token);
    location.href = '/dashboard.html';
  } catch (err) {
    showMsg($('code-msg'), err.message);
    $('btn-verify').disabled = false;
  }
}
