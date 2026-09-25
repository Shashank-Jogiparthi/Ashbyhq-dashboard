/**
 * Mailer stub for the Microsoft Authenticator / one-time-code flow.
 *
 * The dashboard issues a 6-digit code on sign-in/sign-up. In this local
 * skeleton the code is printed to the server console instead of being
 * emailed. When real mail access is wired up later, implement sendCode()
 * with SMTP (e.g. nodemailer + the org mailbox) — nothing else changes.
 */
export async function sendAuthCode(email, code) {
  console.log('\n┌────────────── AUTH CODE (mailer stub) ──────────────┐');
  console.log(`│  To: ${email.padEnd(50)}│`);
  console.log(`│  Your one-time code: ${code.padEnd(31)}│`);
  console.log('│  (Connect a real mail sender in core/mailer.js)      │');
  console.log('└──────────────────────────────────────────────────────┘\n');
  return { delivered: 'console-stub' };
}
