import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { one } from '../db.js';
import { HttpError } from '../lib/auth.js';
import { hashPassword, seal, unseal, verifyPassword } from '../lib/crypto.js';
import { audit, passwordProblem } from '../lib/security.js';
import { otpauthUri, newTotpSecret, verifyTotp } from '../lib/totp.js';
import { LOGIN_COLS, TOTP_PURPOSE, bumpSessions, newRecoveryCodes, type LoginRow } from '../services/staffSecurity.js';
import { staffGuard } from './staff.js';

/** The signed-in team member's own account security: password, two-step sign-in, devices. */
export async function securityRoutes(app: FastifyInstance) {
  const svc = app.svc;
  const { db, cfg, sessions } = svc;
  const signedIn = staffGuard(svc, 'staff');

  const load = async (id: string) => (await one<LoginRow & { password_changed_at: Date | null }>(
    db,
    `SELECT ${LOGIN_COLS}, password_changed_at FROM staff_users WHERE id = $1`,
    [id],
  ))!;

  app.get('/', async (req) => {
    const s = await signedIn(req);
    const u = await load(s.id);
    const p = await one<{ require_two_step: boolean; brand_name: string }>(db, 'SELECT require_two_step, brand_name FROM program WHERE id = 1');
    return {
      email: u.email,
      twoStep: !!u.totp_enabled_at,
      twoStepSince: u.totp_enabled_at,
      backupCodesLeft: u.totp_enabled_at ? u.recovery_codes.length : 0,
      passwordChangedAt: u.password_changed_at,
      requireTwoStep: !!p?.require_two_step && s.role !== 'staff',
    };
  });

  app.post('/password', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req, reply) => {
    const s = await signedIn(req);
    const b = z.object({ current: z.string().min(1).max(200), next: z.string().max(200) }).parse(req.body);
    const u = await load(s.id);
    if (!(await verifyPassword(b.current, u.password_hash))) throw new HttpError(400, 'Your current password is not right');
    const problem = passwordProblem(b.next, u.email);
    if (problem) throw new HttpError(400, problem);
    if (b.next === b.current) throw new HttpError(400, 'Choose a password you have not used here before');
    await db.query('UPDATE staff_users SET password_hash = $2, password_changed_at = now() WHERE id = $1', [s.id, await hashPassword(b.next)]);
    // A new password signs out every other device; this one gets a fresh session.
    const version = await bumpSessions(db, s.id);
    await sessions.setStaff(reply, { ...s, version });
    await audit(db, req, { staffId: s.id, action: 'password.changed' });
    return { ok: true };
  });

  app.post('/sign-out-everywhere', async (req, reply) => {
    const s = await signedIn(req);
    const version = await bumpSessions(db, s.id);
    await sessions.setStaff(reply, { ...s, version });
    await audit(db, req, { staffId: s.id, action: 'sessions.revoked' });
    return { ok: true };
  });

  // Step 1 of turning on two-step sign-in: a fresh secret for the authenticator app's QR code.
  app.post('/two-step/start', async (req) => {
    const s = await signedIn(req);
    const u = await load(s.id);
    if (u.totp_enabled_at) throw new HttpError(400, 'Two-step sign-in is already on');
    const secret = newTotpSecret();
    await db.query('UPDATE staff_users SET totp_secret_enc = $2, totp_last_step = NULL WHERE id = $1', [s.id, seal(cfg.secret, TOTP_PURPOSE, secret)]);
    const p = await one<{ brand_name: string }>(db, 'SELECT brand_name FROM program WHERE id = 1');
    return { secret, uri: otpauthUri(secret, u.email, p?.brand_name || 'O! Donut') };
  });

  // Step 2: the first code from the app proves it was set up; backup codes are shown once.
  app.post('/two-step/confirm', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const s = await signedIn(req);
    const { code } = z.object({ code: z.string().trim().max(10) }).parse(req.body);
    const u = await load(s.id);
    if (u.totp_enabled_at) throw new HttpError(400, 'Two-step sign-in is already on');
    if (!u.totp_secret_enc) throw new HttpError(400, 'Start again: press "Turn on two-step sign-in"');
    const step = verifyTotp(unseal(cfg.secret, TOTP_PURPOSE, u.totp_secret_enc), code, null);
    if (step === null) throw new HttpError(400, "That code doesn't match. Check the phone's time is set automatically, then try the newest code.");
    const { codes, hashes } = newRecoveryCodes(cfg.secret, s.id);
    await db.query('UPDATE staff_users SET totp_enabled_at = now(), totp_last_step = $2, recovery_codes = $3 WHERE id = $1', [s.id, step, hashes]);
    await audit(db, req, { staffId: s.id, action: 'two_step.enabled' });
    return { ok: true, backupCodes: codes };
  });

  app.post('/two-step/backup-codes', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const s = await signedIn(req);
    const { password } = z.object({ password: z.string().min(1).max(200) }).parse(req.body);
    const u = await load(s.id);
    if (!u.totp_enabled_at) throw new HttpError(400, 'Two-step sign-in is off');
    if (!(await verifyPassword(password, u.password_hash))) throw new HttpError(400, 'Your password is not right');
    const { codes, hashes } = newRecoveryCodes(cfg.secret, s.id);
    await db.query('UPDATE staff_users SET recovery_codes = $2 WHERE id = $1', [s.id, hashes]);
    await audit(db, req, { staffId: s.id, action: 'two_step.backup_codes' });
    return { backupCodes: codes };
  });

  app.post('/two-step/disable', { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } }, async (req) => {
    const s = await signedIn(req);
    const { password } = z.object({ password: z.string().min(1).max(200) }).parse(req.body);
    const u = await load(s.id);
    if (!(await verifyPassword(password, u.password_hash))) throw new HttpError(400, 'Your password is not right');
    const p = await one<{ require_two_step: boolean }>(db, 'SELECT require_two_step FROM program WHERE id = 1');
    if (p?.require_two_step && s.role !== 'staff') throw new HttpError(400, 'Two-step sign-in is required for owners and managers here');
    await db.query(`UPDATE staff_users SET totp_secret_enc = NULL, totp_enabled_at = NULL, totp_last_step = NULL, recovery_codes = '{}' WHERE id = $1`, [s.id]);
    await audit(db, req, { staffId: s.id, action: 'two_step.disabled' });
    return { ok: true };
  });
}
