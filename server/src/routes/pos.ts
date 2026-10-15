import type { FastifyInstance, FastifyRequest } from 'fastify';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { many, one } from '../db.js';
import { HttpError } from '../lib/auth.js';
import { randomToken } from '../lib/crypto.js';
import { addStamps, redeemVoucher } from '../services/loyalty.js';
import type { Services } from '../app.js';
import { afterStamp } from './staff.js';

export function hashApiKey(key: string) {
  return createHash('sha256').update(key).digest('hex');
}

export function newApiKey() {
  const key = `odk_${randomToken(30)}`;
  return { key, prefix: key.slice(0, 12), hash: hashApiKey(key) };
}

interface ApiKey { id: string; name: string; store_id: string | null }

async function authenticate(svc: Services, req: FastifyRequest): Promise<ApiKey> {
  const h = req.headers.authorization ?? '';
  const key = h.startsWith('Bearer ') ? h.slice(7).trim() : '';
  if (!key.startsWith('odk_')) throw new HttpError(401, 'Missing or invalid API key');
  const row = await one<ApiKey>(
    svc.db,
    `UPDATE api_keys SET last_used_at = now() WHERE key_hash = $1 AND revoked_at IS NULL RETURNING id, name, store_id`,
    [hashApiKey(key)],
  );
  if (!row) throw new HttpError(401, 'Missing or invalid API key');
  return row;
}

const memberRef = z
  .object({
    qrToken: z.string().max(100).optional(),
    phone: z.string().max(30).optional(),
    email: z.string().email().max(200).optional(),
    memberId: z.string().uuid().optional(),
  })
  .refine((m) => m.qrToken || m.phone || m.email || m.memberId, 'Give qrToken, phone, email or memberId');

async function resolveMember(svc: Services, ref: z.infer<typeof memberRef>): Promise<string> {
  let rows: { id: string }[] = [];
  if (ref.memberId) rows = await many(svc.db, 'SELECT id FROM customers WHERE id = $1', [ref.memberId]);
  else if (ref.qrToken) rows = await many(svc.db, 'SELECT customer_id AS id FROM cards WHERE qr_token = $1', [ref.qrToken.toUpperCase()]);
  else if (ref.email) rows = await many(svc.db, 'SELECT id FROM customers WHERE email = lower($1)', [ref.email]);
  else if (ref.phone) {
    const digits = ref.phone.replace(/\D/g, '');
    if (digits.length >= 8) {
      rows = await many(
        svc.db,
        `SELECT id FROM customers WHERE right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 8) = right($1, 8) LIMIT 2`,
        [digits],
      );
    }
  }
  if (rows.length === 0) throw new HttpError(404, 'Member not found', 'member_not_found');
  if (rows.length > 1) throw new HttpError(409, 'More than one member has that phone number; use their QR code', 'ambiguous');
  return rows[0].id;
}

async function memberView(svc: Services, customerId: string) {
  const m = await one(
    svc.db,
    `SELECT c.id, c.first_name, c.last_name, c.visit_count, k.stamps, p.stamps_required, t.name AS tier
       FROM customers c JOIN cards k ON k.customer_id = c.id CROSS JOIN program p LEFT JOIN tiers t ON t.id = c.tier_id
      WHERE c.id = $1`,
    [customerId],
  );
  const vouchers = await many(
    svc.db,
    `SELECT v.code, t.title, t.kind, t.value, v.expires_at FROM vouchers v JOIN voucher_templates t ON t.id = v.template_id
      WHERE v.customer_id = $1 AND v.status = 'active' AND v.expires_at > now() ORDER BY v.expires_at`,
    [customerId],
  );
  return { member: m, vouchers };
}

/**
 * Point-of-sale API (v1). Lets a till or online ordering system stamp cards and redeem vouchers
 * automatically. Authenticate with `Authorization: Bearer odk_...` created in Admin → Integrations.
 * Pass your order ID so retries never double-stamp.
 */
export async function posRoutes(app: FastifyInstance) {
  const svc = app.svc;

  app.get('/members/lookup', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req) => {
    await authenticate(svc, req);
    const ref = memberRef.parse(req.query);
    return memberView(svc, await resolveMember(svc, ref));
  });

  app.post('/stamps', { config: { rateLimit: { max: 300, timeWindow: '1 minute' } } }, async (req) => {
    const key = await authenticate(svc, req);
    const b = z
      .object({
        member: memberRef,
        count: z.number().int().min(1).max(20).default(1),
        orderId: z.string().trim().min(1).max(80),
        note: z.string().max(200).optional(),
      })
      .parse(req.body);
    const customerId = await resolveMember(svc, b.member);
    const r = await addStamps(svc.db, {
      customerId,
      count: b.count,
      reason: 'purchase',
      staffId: null,
      storeId: key.store_id,
      apiKeyId: key.id,
      note: b.note ?? `POS order ${b.orderId}`,
      idempotencyKey: `pos:${key.id}:${b.orderId}`,
    });
    if (!r.duplicate) void afterStamp(svc, r);
    return {
      duplicate: r.duplicate,
      stamps: r.card.stamps,
      stampsRequired: r.stampsRequired,
      rewardsIssued: r.rewards.map((v) => ({ code: v.code, title: v.title })),
      tier: r.tier?.to?.name ?? null,
    };
  });

  app.get('/vouchers/:code', async (req) => {
    await authenticate(svc, req);
    const { code } = z.object({ code: z.string().max(40) }).parse(req.params);
    const v = await one(
      svc.db,
      `SELECT v.code, v.status, v.expires_at, v.redeemed_at, t.title, t.kind, t.value, v.customer_id AS member_id
         FROM vouchers v JOIN voucher_templates t ON t.id = v.template_id WHERE v.code = $1`,
      [code.toUpperCase()],
    );
    if (!v) throw new HttpError(404, 'Voucher not found');
    return v;
  });

  app.post('/vouchers/redeem', async (req) => {
    const key = await authenticate(svc, req);
    const b = z.object({ code: z.string().trim().min(3).max(40), orderId: z.string().max(80).optional() }).parse(req.body);
    const r = await redeemVoucher(svc.db, b.code, null, key.store_id, key.id);
    void svc.notifier.passChanged(r.customerId).catch(() => {});
    return { ok: true, title: r.title };
  });
}
