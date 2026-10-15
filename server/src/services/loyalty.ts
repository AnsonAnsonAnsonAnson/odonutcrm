import { one, many, withTx, type Db, type Queryable, type Tx } from '../db.js';
import { HttpError } from '../lib/auth.js';
import { randomCode, randomToken } from '../lib/crypto.js';
import { getProgram, type CardRow } from './program.js';
import { reevaluateTier, type TierChange } from './tiers.js';

export interface IssuedVoucher {
  id: string;
  code: string;
  title: string;
  expires_at: Date;
  source: string;
}

export type VoucherSource = 'welcome' | 'stamp_reward' | 'birthday' | 'winback' | 'promo' | 'referral' | 'campaign' | 'manual' | 'tier_upgrade';

export async function issueVoucher(
  q: Queryable,
  customerId: string,
  templateId: string,
  source: VoucherSource,
  sourceRef: string | null = null,
): Promise<IssuedVoucher | null> {
  const tpl = await one<{ title: string; valid_days: number; active: boolean }>(
    q,
    'SELECT title, valid_days, active FROM voucher_templates WHERE id = $1',
    [templateId],
  );
  if (!tpl || !tpl.active) return null;
  for (let attempt = 0; attempt < 5; attempt++) {
    const code = 'V' + randomCode(9);
    const row = await one<IssuedVoucher>(
      q,
      `INSERT INTO vouchers (customer_id, template_id, code, source, source_ref, expires_at)
       VALUES ($1, $2, $3, $4, $5, now() + make_interval(days => $6))
       ON CONFLICT DO NOTHING
       RETURNING id, code, expires_at, source`,
      [customerId, templateId, code, source, sourceRef, tpl.valid_days],
    );
    if (row) return { ...row, title: tpl.title };
    // Conflict: either a code collision (retry) or the once-per-source guard (stop).
    if (sourceRef && ['promo', 'campaign', 'referral', 'tier_upgrade'].includes(source)) {
      const dup = await one(q, 'SELECT 1 FROM vouchers WHERE customer_id = $1 AND source = $2 AND source_ref = $3', [
        customerId,
        source,
        sourceRef,
      ]);
      if (dup) return null;
    }
  }
  throw new Error('Could not allocate a voucher code');
}

export interface NewCustomer {
  email: string;
  firstName: string;
  lastName: string;
  phone?: string | null;
  birthday?: string | null;
  gender?: string | null;
  locale?: string;
  marketingOptIn: boolean;
  referralCode?: string | null;
}

export async function createCustomer(tx: Tx, input: NewCustomer) {
  const program = await getProgram(tx);
  let referredBy: string | null = null;
  if (input.referralCode) {
    const ref = await one<{ id: string }>(tx, 'SELECT id FROM customers WHERE referral_code = $1', [
      input.referralCode.trim().toUpperCase(),
    ]);
    referredBy = ref?.id ?? null;
  }
  const customer = await one<{ id: string; referral_code: string }>(
    tx,
    `INSERT INTO customers (email, first_name, last_name, phone, birthday, gender, locale, marketing_opt_in, referral_code, referred_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING id, referral_code`,
    [
      input.email.toLowerCase(),
      input.firstName,
      input.lastName,
      input.phone ?? null,
      input.birthday ?? null,
      input.gender ?? null,
      input.locale ?? 'en',
      input.marketingOptIn,
      randomCode(7),
      referredBy,
    ],
  );
  const card = await one<CardRow>(
    tx,
    `INSERT INTO cards (customer_id, serial_number, auth_token, qr_token) VALUES ($1,$2,$3,$4) RETURNING *`,
    [customer!.id, 'OD' + randomCode(12), randomToken(24), 'ODC-' + randomCode(14)],
  );
  if (program.tiers_enabled) {
    await tx.query(
      `UPDATE customers SET tier_id = (SELECT id FROM tiers WHERE min_stamps = 0), tier_since = now() WHERE id = $1`,
      [customer!.id],
    );
  }
  const vouchers: IssuedVoucher[] = [];
  if (program.welcome_template_id) {
    const v = await issueVoucher(tx, customer!.id, program.welcome_template_id, 'welcome');
    if (v) vouchers.push(v);
  }
  return { customer: customer!, card: card!, vouchers };
}

export interface StampInput {
  qrToken?: string;
  cardId?: string;
  count: number;
  reason: 'purchase' | 'bonus' | 'adjustment';
  staffId: string | null;
  storeId: string | null;
  note?: string;
  idempotencyKey?: string;
  bypassLimits?: boolean;
  apiKeyId?: string | null;
  customerId?: string;
}

export interface StampResult {
  duplicate: boolean;
  customerId: string;
  card: CardRow;
  stampsRequired: number;
  rewards: IssuedVoucher[];
  referrer: { customerId: string; voucher: IssuedVoucher } | null;
  tier: TierChange | null;
}

export async function addStamps(db: Db, input: StampInput): Promise<StampResult> {
  if (!Number.isInteger(input.count) || input.count === 0) throw new HttpError(400, 'Stamp count must be a non-zero whole number');
  if (input.count < 0 && input.reason !== 'adjustment') throw new HttpError(400, 'Only adjustments can remove stamps');

  return withTx(db, async (tx) => {
    const program = await getProgram(tx);
    const card = input.cardId
      ? await one<CardRow>(tx, 'SELECT * FROM cards WHERE id = $1 FOR UPDATE', [input.cardId])
      : input.customerId
        ? await one<CardRow>(tx, 'SELECT * FROM cards WHERE customer_id = $1 FOR UPDATE', [input.customerId])
        : await one<CardRow>(tx, 'SELECT * FROM cards WHERE qr_token = $1 FOR UPDATE', [input.qrToken]);
    if (!card) throw new HttpError(404, 'Card not found');

    if (input.idempotencyKey) {
      const prior = await one(tx, 'SELECT 1 FROM stamp_events WHERE idempotency_key = $1', [input.idempotencyKey]);
      if (prior) {
        return { duplicate: true, customerId: card.customer_id, card, stampsRequired: program.stamps_required, rewards: [], referrer: null, tier: null };
      }
    }

    if (!input.bypassLimits) {
      if (input.count > program.max_stamps_per_scan) {
        throw new HttpError(400, `At most ${program.max_stamps_per_scan} stamps per scan`);
      }
      if (input.reason === 'purchase' && program.stamp_cooldown_seconds > 0) {
        const recent = await one(
          tx,
          `SELECT 1 FROM stamp_events WHERE card_id = $1 AND reason = 'purchase'
             AND created_at > now() - make_interval(secs => $2)`,
          [card.id, program.stamp_cooldown_seconds],
        );
        if (recent) throw new HttpError(429, 'This card was just stamped. Wait a moment before stamping again.', 'cooldown');
      }
    }

    const delta = Math.max(input.count, -card.stamps);
    await tx.query(
      `INSERT INTO stamp_events (card_id, delta, reason, staff_id, store_id, note, idempotency_key, api_key_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
      [card.id, delta, input.reason, input.staffId, input.storeId, input.note ?? null, input.idempotencyKey ?? null, input.apiKeyId ?? null],
    );

    let stamps = card.stamps + delta;
    const rewards: IssuedVoucher[] = [];
    while (stamps >= program.stamps_required) {
      stamps -= program.stamps_required;
      await tx.query(
        `INSERT INTO stamp_events (card_id, delta, reason, staff_id, store_id, note) VALUES ($1,$2,'reward_rollover',$3,$4,'Card completed')`,
        [card.id, -program.stamps_required, input.staffId, input.storeId],
      );
      if (program.reward_template_id) {
        const v = await issueVoucher(tx, card.customer_id, program.reward_template_id, 'stamp_reward', card.id);
        if (v) rewards.push(v);
      }
    }

    const updated = await one<CardRow>(
      tx,
      `UPDATE cards SET stamps = $2, lifetime_stamps = lifetime_stamps + GREATEST($3, 0),
              rewards_earned = rewards_earned + $4, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [card.id, stamps, delta, Math.floor((card.stamps + delta) / program.stamps_required)],
    );

    let referrer: StampResult['referrer'] = null;
    if (input.reason === 'purchase') {
      const cust = await one<{ visit_count: number; referred_by: string | null }>(
        tx,
        `UPDATE customers SET visit_count = visit_count + 1, last_visit_at = now() WHERE id = $1
         RETURNING visit_count, referred_by`,
        [card.customer_id],
      );
      // Referrer is rewarded when their friend makes a first real purchase, not at sign-up.
      if (cust && cust.visit_count === 1 && cust.referred_by && program.referral_enabled && program.referral_template_id) {
        const v = await issueVoucher(tx, cust.referred_by, program.referral_template_id, 'referral', card.customer_id);
        if (v) referrer = { customerId: cust.referred_by, voucher: v };
      }
    }

    const tier = program.tiers_enabled ? await reevaluateTier(tx, card.customer_id, program.tier_window_days) : null;

    return { duplicate: false, customerId: card.customer_id, card: updated!, stampsRequired: program.stamps_required, rewards, referrer, tier };
  });
}

export async function redeemVoucher(db: Db, code: string, staffId: string | null, storeId: string | null, apiKeyId: string | null = null) {
  return withTx(db, async (tx) => {
    const v = await one<{ id: string; customer_id: string; status: string; expires_at: Date; title: string }>(
      tx,
      `SELECT v.id, v.customer_id, v.status, v.expires_at, t.title FROM vouchers v
         JOIN voucher_templates t ON t.id = v.template_id
        WHERE v.code = $1 FOR UPDATE OF v`,
      [code.trim().toUpperCase()],
    );
    if (!v) throw new HttpError(404, 'Voucher not found');
    if (v.status === 'redeemed') throw new HttpError(409, 'Voucher already used', 'already_redeemed');
    if (v.status !== 'active') throw new HttpError(409, `Voucher is ${v.status}`, v.status);
    if (new Date(v.expires_at) < new Date()) {
      await tx.query(`UPDATE vouchers SET status = 'expired' WHERE id = $1`, [v.id]);
      throw new HttpError(409, 'Voucher has expired', 'expired');
    }
    await tx.query(
      `UPDATE vouchers SET status = 'redeemed', redeemed_at = now(), redeemed_by = $2, redeemed_store_id = $3, redeemed_api_key_id = $4 WHERE id = $1`,
      [v.id, staffId, storeId, apiKeyId],
    );
    await tx.query('UPDATE cards SET updated_at = now() WHERE customer_id = $1', [v.customer_id]);
    return { voucherId: v.id, customerId: v.customer_id, title: v.title };
  });
}

export async function applyPromoCode(db: Db, customerId: string, rawCode: string) {
  return withTx(db, async (tx) => {
    const promo = await one<{
      id: string;
      template_id: string;
      max_uses: number | null;
      uses: number;
      starts_at: Date | null;
      ends_at: Date | null;
      active: boolean;
    }>(tx, 'SELECT * FROM promo_codes WHERE code = $1 FOR UPDATE', [rawCode.trim().toUpperCase()]);
    const now = new Date();
    if (!promo || !promo.active || (promo.starts_at && promo.starts_at > now)) throw new HttpError(404, 'That promo code is not valid');
    if (promo.ends_at && promo.ends_at < now) throw new HttpError(410, 'That promo code has ended');
    if (promo.max_uses !== null && promo.uses >= promo.max_uses) throw new HttpError(410, 'That promo code has been fully claimed');
    const v = await issueVoucher(tx, customerId, promo.template_id, 'promo', promo.id);
    if (!v) throw new HttpError(409, 'You have already used this promo code');
    await tx.query('UPDATE promo_codes SET uses = uses + 1 WHERE id = $1', [promo.id]);
    await tx.query('UPDATE cards SET updated_at = now() WHERE customer_id = $1', [customerId]);
    return v;
  });
}

export async function customerVouchers(q: Queryable, customerId: string) {
  return many(
    q,
    `SELECT v.id, v.code, v.status, v.source, v.expires_at, v.redeemed_at, v.created_at,
            t.title, t.description, t.kind, t.value
       FROM vouchers v JOIN voucher_templates t ON t.id = v.template_id
      WHERE v.customer_id = $1
      ORDER BY (v.status = 'active' AND v.expires_at > now()) DESC, v.expires_at ASC
      LIMIT 100`,
    [customerId],
  );
}

export async function customerHistory(q: Queryable, customerId: string) {
  return many(
    q,
    `SELECT * FROM (
       SELECT e.created_at AS at, 'stamp' AS type, e.delta, e.reason AS detail, s.name AS store
         FROM stamp_events e JOIN cards c ON c.id = e.card_id LEFT JOIN stores s ON s.id = e.store_id
        WHERE c.customer_id = $1 AND e.reason <> 'reward_rollover'
       UNION ALL
       SELECT v.created_at, 'voucher_issued', NULL, t.title, NULL
         FROM vouchers v JOIN voucher_templates t ON t.id = v.template_id WHERE v.customer_id = $1
       UNION ALL
       SELECT v.redeemed_at, 'voucher_redeemed', NULL, t.title, s.name
         FROM vouchers v JOIN voucher_templates t ON t.id = v.template_id LEFT JOIN stores s ON s.id = v.redeemed_store_id
        WHERE v.customer_id = $1 AND v.redeemed_at IS NOT NULL
     ) h ORDER BY at DESC LIMIT 100`,
    [customerId],
  );
}
