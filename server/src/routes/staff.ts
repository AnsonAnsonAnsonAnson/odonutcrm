import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { many, one } from '../db.js';
import { HttpError, STAFF_COOKIE, STAFF_PENDING_COOKIE, hasRole, type StaffRole, type StaffSession } from '../lib/auth.js';
import { audit } from '../lib/security.js';
import { LOCK_AFTER, LOGIN_COLS, DUMMY_HASH, assertNotLocked, checkSecondFactor, type LoginRow } from '../services/staffSecurity.js';
import { verifyPassword } from '../lib/crypto.js';
import { addStamps, redeemVoucher, undoRedeem, undoStamp, type StampResult } from '../services/loyalty.js';
import { activeMultiplier, getProgram } from '../services/program.js';
import type { Services } from '../app.js';

declare module 'fastify' {
  interface FastifyRequest {
    staffSession?: StaffSession;
  }
}

interface StaffRow {
  active: boolean;
  role: StaffRole;
  store_id: string | null;
  name: string;
  session_version: number;
  totp_enabled_at: Date | null;
}

/**
 * Checks the staff cookie against the account as it is now, so a disabled account, a changed
 * role or a "sign out everywhere" takes effect on the very next request, not when the cookie expires.
 * Admin areas (min manager) also enforce the owner's "require two-step sign-in" setting.
 */
export function staffGuard(svc: Services, min: StaffRole) {
  return async (req: FastifyRequest): Promise<StaffSession> => {
    const s = await svc.sessions.staff(req);
    if (!s) throw new HttpError(401, 'Please sign in');
    const row = await one<StaffRow & { require_two_step: boolean }>(
      svc.db,
      `SELECT u.active, u.role, u.store_id, u.name, u.session_version, u.totp_enabled_at,
              (SELECT require_two_step FROM program WHERE id = 1) AS require_two_step
         FROM staff_users u WHERE u.id = $1`,
      [s.id],
    );
    if (!row?.active) throw new HttpError(401, 'Your account is disabled');
    if (row.session_version !== s.version) throw new HttpError(401, 'You were signed out. Please sign in again.');
    const session: StaffSession = { id: s.id, role: row.role, storeId: row.store_id, name: row.name, version: row.session_version };
    if (!hasRole(session, min)) throw new HttpError(403, 'You do not have access to this');
    if (min !== 'staff' && row.require_two_step && !row.totp_enabled_at) {
      throw new HttpError(403, 'Turn on two-step sign-in to use the admin area.', 'two_step_required');
    }
    req.staffSession = session;
    return session;
  };
}

async function customerSummary(svc: Services, customerId: string) {
  const c = await one(
    svc.db,
    `SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.visit_count, c.last_visit_at, c.created_at, c.birthday,
            k.id AS card_id, k.qr_token, k.stamps, k.lifetime_stamps, k.rewards_earned, t.name AS tier,
            (SELECT stamps_required FROM program WHERE id = 1) AS stamps_required
       FROM customers c JOIN cards k ON k.customer_id = c.id LEFT JOIN tiers t ON t.id = c.tier_id WHERE c.id = $1`,
    [customerId],
  );
  const vouchers = await many(
    svc.db,
    `SELECT v.code, v.expires_at, t.title, t.description FROM vouchers v JOIN voucher_templates t ON t.id = v.template_id
      WHERE v.customer_id = $1 AND v.status = 'active' AND v.expires_at > now() ORDER BY v.expires_at`,
    [customerId],
  );
  return { customer: c, vouchers };
}

/** After a stamp, refresh wallets and send any reward / referral messages. Never fails the request. */
export async function afterStamp(svc: Services, r: StampResult) {
  try {
    if (r.tier?.upgraded && r.tier.to) {
      await svc.notifier.notify(r.customerId, {
        kind: 'tier',
        title: `Welcome to ${r.tier.to.name}!`,
        body: r.tier.voucher ? `${r.tier.voucher.title} is waiting in your Member Center.` : r.tier.to.perks || 'Thanks for being a regular.',
      });
    }
    if (r.rewards.length) {
      const title = r.rewards.length > 1 ? `${r.rewards.length} rewards unlocked!` : 'Reward unlocked!';
      await svc.notifier.notify(r.customerId, { kind: 'reward', title, body: `${r.rewards[0].title} is ready in your Member Center.` });
    } else {
      await svc.notifier.passChanged(r.customerId);
    }
    if (r.referrer) {
      await svc.notifier.notify(r.referrer.customerId, {
        kind: 'referral',
        title: 'Your friend visited!',
        body: `Thanks for sharing. ${r.referrer.voucher.title} is in your wallet.`,
      });
    }
  } catch (err: any) {
    svc.log(`post-stamp notify failed: ${err.message}`);
  }
}

export async function staffRoutes(app: FastifyInstance) {
  const svc = app.svc;
  const { db, sessions } = svc;
  const staff = staffGuard(svc, 'staff');

  app.post(
    '/login',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const b = z.object({ email: z.string().trim().toLowerCase().email().max(200), password: z.string().min(1).max(200) }).parse(req.body);
      const u = await one<LoginRow>(db, `SELECT ${LOGIN_COLS} FROM staff_users WHERE email = $1`, [b.email]);
      if (!u) {
        // Same work as a real check, so response time doesn't reveal which emails have accounts.
        await verifyPassword(b.password, DUMMY_HASH);
        await audit(db, req, { actor: b.email, action: 'login.failed', details: { reason: 'unknown email' } });
        throw new HttpError(401, 'Email or password is incorrect');
      }
      assertNotLocked(u);
      if (!u.active || !(await verifyPassword(b.password, u.password_hash))) {
        await loginFailed(req, u, u.active ? 'wrong password' : 'account disabled');
        throw new HttpError(401, 'Email or password is incorrect');
      }
      if (u.totp_enabled_at) {
        await sessions.setStaffPending(reply, u.id, u.session_version);
        return { status: 'two_step' };
      }
      return loginSucceeded(req, reply, u, 'password');
    },
  );

  // Second step: a 6-digit code from the authenticator app, or one of the printed backup codes.
  app.post(
    '/login/two-step',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const { code } = z.object({ code: z.string().trim().min(6).max(20) }).parse(req.body);
      const pending = await sessions.staffPending(req);
      if (!pending) throw new HttpError(401, 'That took too long. Please sign in again.', 'expired');
      const u = await one<LoginRow>(db, `SELECT ${LOGIN_COLS} FROM staff_users WHERE id = $1`, [pending.id]);
      if (!u || !u.active || !u.totp_enabled_at || u.session_version !== pending.version) {
        throw new HttpError(401, 'Please sign in again.', 'expired');
      }
      assertNotLocked(u);
      const result = await checkSecondFactor(svc, u, code);
      if (!result) {
        await loginFailed(req, u, 'wrong two-step code');
        throw new HttpError(400, 'That code is not right. Check the newest code in your authenticator app.', 'invalid');
      }
      return loginSucceeded(req, reply, u, result);
    },
  );

  async function loginFailed(req: FastifyRequest, u: LoginRow, reason: string) {
    const r = await one<{ failed_logins: number; locked_until: Date | null }>(
      db,
      // From the 5th failure in a row the account locks: 15 minutes, doubling each time, up to a day.
      `UPDATE staff_users SET failed_logins = failed_logins + 1,
              locked_until = CASE WHEN failed_logins + 1 >= $2
                THEN now() + make_interval(mins => least(1440, 15 * power(2, failed_logins + 1 - $2)::int)) ELSE locked_until END
        WHERE id = $1 RETURNING failed_logins, locked_until`,
      [u.id, LOCK_AFTER],
    );
    const locked = (r?.failed_logins ?? 0) >= LOCK_AFTER;
    await audit(db, req, { staffId: u.id, action: locked ? 'login.locked' : 'login.failed', details: { reason, failures: r?.failed_logins } });
  }

  async function loginSucceeded(req: FastifyRequest, reply: FastifyReply, u: LoginRow, method: string) {
    await db.query('UPDATE staff_users SET last_login_at = now(), failed_logins = 0, locked_until = NULL WHERE id = $1', [u.id]);
    await sessions.setStaff(reply, { id: u.id, role: u.role, storeId: u.store_id, name: u.name, version: u.session_version });
    await audit(db, req, { staffId: u.id, action: 'login.ok', details: { method } });
    return { status: 'ok', id: u.id, name: u.name, role: u.role, storeId: u.store_id };
  }

  app.post('/logout', async (req, reply) => {
    const s = await sessions.staff(req);
    reply.clearCookie(STAFF_COOKIE, { path: '/' });
    reply.clearCookie(STAFF_PENDING_COOKIE, { path: '/' });
    if (s) await audit(db, req, { staffId: s.id, action: 'logout' });
    return { ok: true };
  });

  app.get('/me', async (req) => {
    const s = await staff(req);
    const store = s.storeId ? await one(db, 'SELECT id, name FROM stores WHERE id = $1', [s.storeId]) : null;
    const program = await one(
      db,
      'SELECT stamps_required, max_stamps_per_scan, spend_per_stamp, brand_name, background_color, foreground_color FROM program WHERE id = 1',
    );
    const sec = await one<{ two_step: boolean; required: boolean }>(
      db,
      `SELECT u.totp_enabled_at IS NOT NULL AS two_step, p.require_two_step AS required FROM staff_users u, program p WHERE u.id = $1 AND p.id = 1`,
      [s.id],
    );
    const { version: _v, ...me } = s;
    return {
      ...me,
      store,
      program,
      promo: activeMultiplier(await getProgram(db)),
      security: { twoStep: !!sec?.two_step, twoStepRequired: !!sec?.required && s.role !== 'staff' },
    };
  });

  // Resolve whatever the scanner read: a member card QR or a voucher code.
  app.post('/scan', async (req) => {
    await staff(req);
    const { code } = z.object({ code: z.string().trim().min(3).max(200) }).parse(req.body);
    const value = code.toUpperCase();
    if (value.startsWith('ODC-')) {
      const card = await one<{ customer_id: string }>(db, 'SELECT customer_id FROM cards WHERE qr_token = $1', [value]);
      if (!card) throw new HttpError(404, 'Card not recognised');
      return { type: 'card', ...(await customerSummary(svc, card.customer_id)) };
    }
    const v = await one<{ customer_id: string; code: string; status: string; expires_at: Date; title: string; description: string }>(
      db,
      `SELECT v.customer_id, v.code, v.status, v.expires_at, t.title, t.description
         FROM vouchers v JOIN voucher_templates t ON t.id = v.template_id WHERE v.code = $1`,
      [value],
    );
    if (!v) throw new HttpError(404, 'Code not recognised');
    return { type: 'voucher', voucher: v, ...(await customerSummary(svc, v.customer_id)) };
  });

  // Fallback when the customer has no phone handy: look up by mobile number or email.
  app.get('/lookup', async (req) => {
    await staff(req);
    const { q } = z.object({ q: z.string().trim().min(4).max(200) }).parse(req.query);
    const digits = q.replace(/[^\d]/g, '');
    const rows = await many<{ id: string }>(
      db,
      `SELECT id FROM customers WHERE email = lower($1) OR ($2 <> '' AND right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 8) = right($2, 8)) LIMIT 5`,
      [q, digits.length >= 8 ? digits : ''],
    );
    return Promise.all(rows.map((r) => customerSummary(svc, r.id)));
  });

  app.post('/stamp', async (req) => {
    const s = await staff(req);
    const b = z
      .object({
        qrToken: z.string().max(100).optional(),
        cardId: z.string().uuid().optional(),
        count: z.number().int().min(1).max(20).optional(),
        // Bill total in dollars: stamps are worked out from it when no count is given.
        amount: z.number().min(0).max(100000).optional(),
        idempotencyKey: z.string().max(100).optional(),
      })
      .refine((v) => v.qrToken || v.cardId, 'qrToken or cardId is required')
      .parse(req.body);
    const r = await addStamps(db, {
      qrToken: b.qrToken?.toUpperCase(),
      cardId: b.cardId,
      count: b.count ?? (b.amount === undefined ? 1 : undefined),
      amount: b.amount,
      reason: 'purchase',
      staffId: s.id,
      storeId: s.storeId,
      idempotencyKey: b.idempotencyKey,
    });
    if (!r.duplicate) void afterStamp(svc, r);
    return {
      duplicate: r.duplicate,
      stamps: r.card.stamps,
      stampsRequired: r.stampsRequired,
      rewards: r.rewards.map((v) => ({ title: v.title, code: v.code })),
      tierUpgrade: r.tier?.upgraded && r.tier.to ? r.tier.to.name : null,
      bonus: r.bonus,
      added: r.duplicate ? 0 : r.added,
      eventId: r.eventId,
    };
  });

  // A mistake at the counter (wrong member, wrong bill): take the stamps back within a few minutes.
  app.post('/stamp/undo', async (req) => {
    const s = await staff(req);
    const { eventId } = z.object({ eventId: z.string().uuid() }).parse(req.body);
    const r = await undoStamp(db, eventId, { staffId: s.id, isManager: hasRole(s, 'manager') });
    await audit(db, req, { staffId: s.id, action: 'stamp.undo', target: r.customerId, details: { removed: r.removed, vouchersVoided: r.vouchersVoided } });
    for (const id of [r.customerId, ...r.alsoChanged]) void svc.notifier.passChanged(id).catch(() => {});
    return { ok: true, removed: r.removed, vouchersVoided: r.vouchersVoided, stamps: r.card.stamps, stampsRequired: r.stampsRequired };
  });

  app.post('/redeem', async (req) => {
    const s = await staff(req);
    const { code } = z.object({ code: z.string().trim().min(3).max(40) }).parse(req.body);
    const r = await redeemVoucher(db, code, s.id, s.storeId);
    void svc.notifier.passChanged(r.customerId).catch(() => {});
    return { ok: true, title: r.title, code: code.trim().toUpperCase() };
  });

  // Redeemed the wrong voucher (or the member changed their mind): put it back within a few minutes.
  app.post('/redeem/undo', async (req) => {
    const s = await staff(req);
    const { code } = z.object({ code: z.string().trim().min(3).max(40) }).parse(req.body);
    const r = await undoRedeem(db, code, { staffId: s.id, isManager: hasRole(s, 'manager') });
    await audit(db, req, { staffId: s.id, action: 'voucher.unredeem', target: r.customerId, details: { code: code.toUpperCase() } });
    void svc.notifier.passChanged(r.customerId).catch(() => {});
    return { ok: true, title: r.title };
  });

  app.get('/activity', async (req) => {
    const s = await staff(req);
    return many(
      db,
      `SELECT * FROM (
         SELECT e.created_at AS at, 'stamp' AS type, e.delta, c.first_name || ' ' || left(c.last_name, 1) AS customer, u.name AS staff
           FROM stamp_events e JOIN cards k ON k.id = e.card_id JOIN customers c ON c.id = k.customer_id
           LEFT JOIN staff_users u ON u.id = e.staff_id
          WHERE e.reason = 'purchase' AND e.created_at > now() - interval '24 hours'
            AND ($1::uuid IS NULL OR e.store_id = $1)
         UNION ALL
         SELECT v.redeemed_at, 'redeem', NULL, c.first_name || ' ' || left(c.last_name, 1) || ' · ' || t.title, u.name
           FROM vouchers v JOIN customers c ON c.id = v.customer_id JOIN voucher_templates t ON t.id = v.template_id
           LEFT JOIN staff_users u ON u.id = v.redeemed_by
          WHERE v.redeemed_at > now() - interval '24 hours' AND ($1::uuid IS NULL OR v.redeemed_store_id = $1)
       ) a ORDER BY at DESC LIMIT 50`,
      [s.storeId],
    );
  });
}
