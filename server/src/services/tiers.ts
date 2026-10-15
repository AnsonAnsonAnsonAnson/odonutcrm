import { many, one, type Queryable } from '../db.js';
import { issueVoucher, type IssuedVoucher } from './loyalty.js';

export interface Tier {
  id: string;
  name: string;
  min_stamps: number;
  perks: string;
  upgrade_template_id: string | null;
  color: string;
}

export async function listTiers(q: Queryable): Promise<Tier[]> {
  return many<Tier>(q, 'SELECT * FROM tiers ORDER BY min_stamps');
}

/** Stamps that count toward tier status: purchases and bonuses inside the rolling window. */
export async function qualifyingStamps(q: Queryable, customerId: string, windowDays: number): Promise<number> {
  const r = await one<{ n: number }>(
    q,
    `SELECT coalesce(sum(e.delta), 0)::int AS n FROM stamp_events e JOIN cards k ON k.id = e.card_id
      WHERE k.customer_id = $1 AND e.delta > 0 AND e.reason IN ('purchase','bonus')
        AND e.created_at > now() - make_interval(days => $2)`,
    [customerId, windowDays],
  );
  return r?.n ?? 0;
}

export function tierFor(tiers: Tier[], stamps: number): Tier | null {
  let best: Tier | null = null;
  for (const t of tiers) if (t.min_stamps <= stamps) best = t;
  return best;
}

export interface TierChange {
  from: Tier | null;
  to: Tier | null;
  upgraded: boolean;
  voucher: IssuedVoucher | null;
}

/**
 * Re-evaluates a member's tier. Upgrades issue the tier's welcome voucher (once per tier ever).
 * Returns null when nothing changed.
 */
export async function reevaluateTier(q: Queryable, customerId: string, windowDays: number, tiers?: Tier[]): Promise<TierChange | null> {
  const all = tiers ?? (await listTiers(q));
  if (!all.length) return null;
  const cur = await one<{ tier_id: string | null }>(q, 'SELECT tier_id FROM customers WHERE id = $1', [customerId]);
  if (!cur) return null;
  const n = await qualifyingStamps(q, customerId, windowDays);
  const to = tierFor(all, n);
  if ((to?.id ?? null) === cur.tier_id) return null;
  const from = all.find((t) => t.id === cur.tier_id) ?? null;
  await q.query('UPDATE customers SET tier_id = $2, tier_since = now() WHERE id = $1', [customerId, to?.id ?? null]);
  await q.query('UPDATE cards SET updated_at = now() WHERE customer_id = $1', [customerId]);
  const upgraded = !!to && (from === null ? to.min_stamps > 0 : to.min_stamps > from.min_stamps);
  let voucher: IssuedVoucher | null = null;
  if (upgraded && to?.upgrade_template_id) {
    voucher = await issueVoucher(q, customerId, to.upgrade_template_id, 'tier_upgrade', to.id);
  }
  return { from, to, upgraded, voucher };
}

/** Progress shown to members: current tier, next tier and stamps still needed. */
export async function tierProgress(q: Queryable, customerId: string, windowDays: number) {
  const tiers = await listTiers(q);
  if (!tiers.length) return null;
  const n = await qualifyingStamps(q, customerId, windowDays);
  const current = tierFor(tiers, n);
  const next = tiers.find((t) => t.min_stamps > n) ?? null;
  return {
    current: current && { name: current.name, perks: current.perks, color: current.color },
    next: next && { name: next.name, perks: next.perks, needed: next.min_stamps - n },
    stamps: n,
    windowDays,
  };
}
