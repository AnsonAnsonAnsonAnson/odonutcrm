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
  updated_at: Date;
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
  customer: { id: string; first_name: string; last_name: string; email: string; locale: string };
  activeVouchers: number;
  stores: { name: string; latitude: number; longitude: number; relevant_text: string | null }[];
}

export async function loadPassData(q: Queryable, by: { serial?: string; customerId?: string }): Promise<PassData | null> {
  const card = by.serial
    ? await one<CardRow>(q, 'SELECT * FROM cards WHERE serial_number = $1', [by.serial])
    : await one<CardRow>(q, 'SELECT * FROM cards WHERE customer_id = $1', [by.customerId]);
  if (!card) return null;
  const customer = await one(q, 'SELECT id, first_name, last_name, email, locale FROM customers WHERE id = $1', [card.customer_id]);
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
