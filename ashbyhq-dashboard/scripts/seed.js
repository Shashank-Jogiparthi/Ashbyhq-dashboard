/**
 * ApplyWizz staff provisioner.
 * Run: node scripts/seed.js   (idempotent — re-running never duplicates)
 *
 * This ONLY ensures the field-user sign-in accounts exist. It no longer seeds
 * fake applicants / job-links / applications — real applicants come from the
 * Azure CRM sync, and their links/actions live in Supabase.
 *
 * Sign-in is OTP-based, so any of these emails can log in immediately; a new
 * email self-signs-up through the UI with the role it picks.
 */
import { db, nowIso, uuid } from '../db/index.js';
import { migrate } from '../db/index.js';

await migrate();

// email -> { name, role, managerEmail }
const STAFF = [
  { email: 'admin2026@applywizz.local', name: 'Admin2026', role: 'admin' },
  { email: 'priya.cam@applywizz.local', name: 'Priya Raman', role: 'ops' },
  { email: 'rakesh@applywizz.local', name: 'Rakesh Kumar', role: 'ca', manager: 'priya.cam@applywizz.local' },
  { email: 'shashank.dev@applywizz.local', name: 'Shashank', role: 'dev' }
];

const findByEmail = db.prepare('SELECT uuid FROM staff WHERE email = ?');
const insertStaff = db.prepare(
  'INSERT INTO staff (uuid, email, name, role, manager_id, active, last_sign_in, created_at) VALUES (?, ?, ?, ?, ?, 1, NULL, ?)'
);

const created = [];
for (const s of STAFF) {
  const existing = await findByEmail.get(s.email);
  if (existing) continue;
  const managerId = s.manager ? (await findByEmail.get(s.manager))?.uuid ?? null : null;
  await insertStaff.run(uuid(), s.email, s.name, s.role, managerId, nowIso());
  created.push(s);
}

console.log(created.length ? 'Created sign-in accounts:' : 'All sign-in accounts already present.');
for (const s of STAFF) {
  console.log(`  ${s.role.toUpperCase().padEnd(4)} ${s.email}${s.manager ? `  (reports to ${s.manager})` : ''}`);
}
