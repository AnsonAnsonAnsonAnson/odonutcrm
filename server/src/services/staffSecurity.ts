import type { Queryable } from '../db.js';
import { HttpError, type StaffRole } from '../lib/auth.js';
import { hmac, randomCode, safeEqual, unseal } from '../lib/crypto.js';
import { verifyTotp } from '../lib/totp.js';
import type { Services } from '../app.js';

export const LOCK_AFTER = 5;
export const TOTP_PURPOSE = 'staff-totp';
// A real scrypt hash of a random throwaway password: checked against when the email is unknown.
export const DUMMY_HASH =
  'scrypt$aC8QLdoBhC4I8ywMHdWL2g==$qrQ1xJ8drnM6eD2EXIfomrmdi9WS1QA3ax1U2MQfT9ClfTrcWEXXBsgx7yYLUXL/ebEdPH8F9ShOdheQzDdryw==';

export const LOGIN_COLS =
  'id, email, name, role, store_id, password_hash, active, session_version, failed_logins, locked_until, totp_secret_enc, totp_enabled_at, totp_last_step, recovery_codes';

export interface LoginRow {
  id: string;
  email: string;
  name: string;
  role: StaffRole;
  store_id: string | null;
  password_hash: string;
  active: boolean;
  session_version: number;
  failed_logins: number;
  locked_until: Date | null;
  totp_secret_enc: string | null;
  totp_enabled_at: Date | null;
  totp_last_step: number | string | null;
  recovery_codes: string[];
}

export function assertNotLocked(u: Pick<LoginRow, 'locked_until'>) {
  if (u.locked_until && u.locked_until.getTime() > Date.now()) {
    const mins = Math.max(1, Math.ceil((u.locked_until.getTime() - Date.now()) / 60000));
    throw new HttpError(
      429,
      `Too many wrong tries, so this account is locked for ${mins} more minute${mins === 1 ? '' : 's'}. An owner can unlock it from Team.`,
      'locked',
    );
  }
}

const recoveryHash = (secret: string, staffId: string, code: string) =>
  hmac(secret, `recovery:${staffId}:${code.toUpperCase().replace(/[^A-Z0-9]/g, '')}`);

/** Eight one-time backup codes like 7KQM-X2PD. Returns the codes to show once and their hashes to store. */
export function newRecoveryCodes(secret: string, staffId: string) {
  const codes = Array.from({ length: 8 }, () => `${randomCode(4)}-${randomCode(4)}`);
  return { codes, hashes: codes.map((c) => recoveryHash(secret, staffId, c)) };
}

/**
 * Checks an authenticator code or a backup code and records its use.
 * Returns how the person got in ('authenticator' | 'backup code'), or null when the code is wrong.
 */
export async function checkSecondFactor(svc: Pick<Services, 'db' | 'cfg'>, u: LoginRow, code: string): Promise<string | null> {
  if (!u.totp_secret_enc) return null;
  const digits = code.replace(/\s/g, '');
  if (/^\d{6}$/.test(digits)) {
    const secret = unseal(svc.cfg.secret, TOTP_PURPOSE, u.totp_secret_enc);
    const last = u.totp_last_step === null ? null : Number(u.totp_last_step);
    const step = verifyTotp(secret, digits, last);
    if (step === null) return null;
    // Conditional update: two requests racing with the same code can't both succeed.
    const r = await svc.db.query(
      'UPDATE staff_users SET totp_last_step = $2 WHERE id = $1 AND (totp_last_step IS NULL OR totp_last_step < $2)',
      [u.id, step],
    );
    return r.rowCount ? 'authenticator' : null;
  }
  const h = recoveryHash(svc.cfg.secret, u.id, code);
  const match = u.recovery_codes.find((x) => safeEqual(x, h));
  if (!match) return null;
  const r = await svc.db.query('UPDATE staff_users SET recovery_codes = array_remove(recovery_codes, $2) WHERE id = $1 AND $2 = ANY(recovery_codes)', [
    u.id,
    match,
  ]);
  return r.rowCount ? 'backup code' : null;
}

/** Signs an account out of every device by invalidating its existing session cookies. */
export async function bumpSessions(db: Queryable, staffId: string): Promise<number> {
  const r = await db.query<{ session_version: number }>(
    'UPDATE staff_users SET session_version = session_version + 1 WHERE id = $1 RETURNING session_version',
    [staffId],
  );
  return r.rows[0]?.session_version ?? 0;
}
