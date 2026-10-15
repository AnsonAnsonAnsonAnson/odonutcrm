import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { many, one } from '../db.js';
import { HttpError, STAFF_COOKIE, hasRole, type StaffRole, type StaffSession } from '../lib/auth.js';
import { verifyPassword } from '../lib/crypto.js';
import { addStamps, redeemVoucher, type StampResult } from '../services/loyalty.js';
import type { Services } from '../app.js';

export function staffGuard(svc: Services, min: StaffRole) {
  return async (req: FastifyRequest): Promise<StaffSession> => {
    const s = await svc.sessions.staff(req);
    if (!s) throw new HttpError(401, 'Please sign in');
    const row = await one<{ active: boolean }>(svc.db, 'SELECT active FROM staff_users WHERE id = $1', [s.id]);
    if (!row?.active) throw new HttpError(401, 'Your account is disabled');
    if (!hasRole(s, min)) throw new HttpError(403, 'You do not have access to this');
    return s;
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
      const b = z.object({ email: z.string().trim().toLowerCase().email(), password: z.string().min(1).max(200) }).parse(req.body);
      const u = await one<{ id: string; name: string; role: StaffRole; store_id: string | null; password_hash: string; active: boolean }>(
        db,
        'SELECT * FROM staff_users WHERE email = $1',
        [b.email],
      );
      if (!u || !u.active || !(await verifyPassword(b.password, u.password_hash))) {
        throw new HttpError(401, 'Email or password is incorrect');
      }
      await db.query('UPDATE staff_users SET last_login_at = now() WHERE id = $1', [u.id]);
      await sessions.setStaff(reply, { id: u.id, role: u.role, storeId: u.store_id, name: u.name });
      return { id: u.id, name: u.name, role: u.role, storeId: u.store_id };
    },
  );

  app.post('/logout', async (_req, reply) => {
    reply.clearCookie(STAFF_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me', async (req) => {
    const s = await staff(req);
    const store = s.storeId ? await one(db, 'SELECT id, name FROM stores WHERE id = $1', [s.storeId]) : null;
    const program = await one(db, 'SELECT stamps_required, max_stamps_per_scan, brand_name, background_color, foreground_color FROM program WHERE id = 1');
    return { ...s, store, program };
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
      `SELECT id FROM customers WHERE lower(email) = lower($1) OR ($2 <> '' AND right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 8) = right($2, 8)) LIMIT 5`,
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
        count: z.number().int().min(1).max(20).default(1),
        idempotencyKey: z.string().max(100).optional(),
      })
      .refine((v) => v.qrToken || v.cardId, 'qrToken or cardId is required')
      .parse(req.body);
    const r = await addStamps(db, {
      qrToken: b.qrToken?.toUpperCase(),
      cardId: b.cardId,
      count: b.count,
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
    };
  });

  app.post('/redeem', async (req) => {
    const s = await staff(req);
    const { code } = z.object({ code: z.string().trim().min(3).max(40) }).parse(req.body);
    const r = await redeemVoucher(db, code, s.id, s.storeId);
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
