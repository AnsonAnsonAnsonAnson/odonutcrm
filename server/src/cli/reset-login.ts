/**
 * Lost the owner password or the phone with the authenticator app? Run on the server:
 *   cd /opt/odonut && sudo docker compose exec app node dist/cli/reset-login.js you@example.com
 * It sets a new random password, turns two-step sign-in off, unlocks the account and signs it out
 * everywhere. Sign in with the printed password, then change it and turn two-step back on.
 */
import { randomBytes } from 'node:crypto';
import { loadConfig } from '../config.js';
import { createPool, one } from '../db.js';
import { hashPassword } from '../lib/crypto.js';
import { audit } from '../lib/security.js';

const email = process.argv[2]?.trim().toLowerCase();
if (!email) {
  console.error('Usage: node dist/cli/reset-login.js <email>');
  process.exit(1);
}
const cfg = loadConfig();
const db = createPool(cfg.databaseUrl, 1);
const password = randomBytes(12).toString('base64url');
const u = await one<{ id: string; name: string; role: string }>(
  db,
  `UPDATE staff_users SET password_hash = $2, password_changed_at = NULL, failed_logins = 0, locked_until = NULL, active = true,
          totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL, recovery_codes = '{}',
          session_version = session_version + 1
    WHERE email = $1 RETURNING id, name, role`,
  [email, await hashPassword(password)],
);
if (!u) {
  const all = await db.query<{ email: string; role: string }>('SELECT email, role FROM staff_users ORDER BY role, email');
  console.error(`No team account uses ${email}. Accounts: ${all.rows.map((r) => `${r.email} (${r.role})`).join(', ') || 'none'}`);
  await db.end();
  process.exit(1);
}
await audit(db, null, { staffId: u.id, actor: 'server command line', action: 'login.reset' });
console.log(`\n${u.name} (${u.role}) can now sign in with:\n  email:    ${email}\n  password: ${password}\n`);
console.log('Two-step sign-in is off for this account. Change the password and turn two-step back on in Admin → Security.');
await db.end();
