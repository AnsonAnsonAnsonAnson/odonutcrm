import { one, many, type Queryable } from '../db.js';

export interface Program {
  name: string;
  brand_name: string;
  stamps_required: number;
  max_stamps_per_scan: number;
  stamp_cooldown_seconds: number;
  background_color: string;
  foreground_color: string;
  label_color: string;
  reward_template_id: string | null;
  welcome_template_id: string | null;
  birthday_enabled: boolean;
  birthday_template_id: string | null;
  birthday_message: string;
  winback_enabled: boolean;
  winback_days: number;
  winback_template_id: string | null;
  winback_message: string;
  referral_enabled: boolean;
  referral_template_id: string | null;
  expiry_reminder_days: number;
  terms: string;
  tiers_enabled: boolean;
  tier_window_days: number;
  near_reward_enabled: boolean;
  near_reward_within: number;
  near_reward_after_days: number;
  near_reward_message: string;
  welcome_email_enabled: boolean;
  privacy_policy: string;
  stamp_multiplier: number;
  multiplier_starts_at: string | Date | null;
  multiplier_ends_at: string | Date | null;
  multiplier_label: string;
  /** Bill amount that earns one stamp. 0 = staff count stamps by hand. */
  spend_per_stamp: number;
  signup_stamps: number;
  reward_voucher_count: number;
  reward_summary: string;
  updated_at: Date;
}

/** "$40" style amount without needless decimals. */
export function money(v: string | number) {
  const n = Number(v);
  return '$' + (Number.isInteger(n) ? String(n) : n.toFixed(2));
}

/** Stamps a bill earns, rounded down. Null when stamps are counted by hand. */
export function stampsForAmount(p: Pick<Program, 'spend_per_stamp'>, amount: number) {
  const per = Number(p.spend_per_stamp);
  if (!(per > 0)) return null;
  // Work in cents so $80.00 / $40 is exactly 2.
  return Math.floor(Math.round(amount * 100) / Math.round(per * 100));
}

/** One-line rules for the pass, the join page and emails. */
export function howItWorks(p: Pick<Program, 'spend_per_stamp' | 'stamps_required' | 'reward_summary'>) {
  const earn = Number(p.spend_per_stamp) > 0 ? `Collect 1 stamp for every ${money(p.spend_per_stamp)} you spend` : 'Collect a stamp with every purchase';
  return `${earn}. ${p.stamps_required} stamps = ${p.reward_summary}.`;
}

export async function getProgram(q: Queryable): Promise<Program> {
  const p = await one<Program>(q, 'SELECT * FROM program WHERE id = 1');
  if (!p) throw new Error('Program not initialised. Run the seed (npm run seed).');
  return p;
}

export interface CardRow {
  id: string;
  customer_id: string;
  serial_number: string;
  auth_token: string;
  qr_token: string;
  stamps: number;
  lifetime_stamps: number;
  rewards_earned: number;
  message: string | null;
  message_updated_at: Date | null;
  google_saved: boolean;
  created_at: Date;
  updated_at: Date;
}

export interface PassData {
  card: CardRow;
  customer: { id: string; first_name: string; last_name: string; email: string; locale: string; tier: string | null };
  activeVouchers: number;
  stores: { name: string; latitude: number; longitude: number; relevant_text: string | null }[];
}

export async function loadPassData(q: Queryable, by: { serial?: string; customerId?: string }): Promise<PassData | null> {
  const card = by.serial
    ? await one<CardRow>(q, 'SELECT * FROM cards WHERE serial_number = $1', [by.serial])
    : await one<CardRow>(q, 'SELECT * FROM cards WHERE customer_id = $1', [by.customerId]);
  if (!card) return null;
  const customer = await one(
    q,
    `SELECT c.id, c.first_name, c.last_name, c.email, c.locale,
            CASE WHEN p.tiers_enabled THEN t.name END AS tier
       FROM customers c CROSS JOIN program p LEFT JOIN tiers t ON t.id = c.tier_id WHERE c.id = $1`,
    [card.customer_id],
  );
  const v = await one<{ n: number }>(
    q,
    `SELECT count(*)::int AS n FROM vouchers WHERE customer_id = $1 AND status = 'active' AND expires_at > now()`,
    [card.customer_id],
  );
  const stores = await many(
    q,
    `SELECT name, latitude, longitude, relevant_text FROM stores
      WHERE active AND latitude IS NOT NULL AND longitude IS NOT NULL ORDER BY created_at LIMIT 10`,
  );
  return { card, customer, activeVouchers: v?.n ?? 0, stores };
}

/** The stamp multiplier in force right now, or null when no promotion is running. */
export function activeMultiplier(p: Program, now = new Date()): { multiplier: number; label: string; endsAt: string | null } | null {
  if (p.stamp_multiplier <= 1) return null;
  if (p.multiplier_starts_at && new Date(p.multiplier_starts_at) > now) return null;
  if (p.multiplier_ends_at && new Date(p.multiplier_ends_at) <= now) return null;
  return { multiplier: p.stamp_multiplier, label: p.multiplier_label, endsAt: p.multiplier_ends_at ? new Date(p.multiplier_ends_at).toISOString() : null };
}
