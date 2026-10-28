import { z } from 'zod';
import { many, one, type Db, type Queryable } from '../db.js';
import { issueVoucher } from './loyalty.js';
import type { Notifier } from './notify.js';

export const SegmentSchema = z.object({
  type: z
    .enum([
      'all', 'active', 'inactive', 'new', 'near_reward', 'birthday_month', 'tag', 'never_visited', 'tier',
      // Ready-made CRM groups (see services/groups.ts).
      'joined_no_visit', 'one_visit', 'regulars', 'top_spenders', 'at_risk', 'reward_waiting', 'referrers',
    ])
    .default('all'),
  tierId: z.string().uuid().optional(),
  days: z.coerce.number().int().min(1).max(3650).optional(),
  tag: z.string().max(50).optional(),
  // Stamps away from a reward, for near_reward.
  within: z.coerce.number().int().min(1).max(19).optional(),
  // Marketing should only reach people who opted in. Off only for service announcements.
  optInOnly: z.boolean().default(true),
});
export type Segment = z.infer<typeof SegmentSchema>;

/** Builds the WHERE clause for a segment. Returns SQL against `customers c JOIN cards k`. */
export function segmentWhere(seg: Segment, params: unknown[]): string {
  const parts: string[] = ['true'];
  const p = (v: unknown) => {
    params.push(v);
    return `$${params.length}`;
  };
  if (seg.optInOnly) parts.push('c.marketing_opt_in');
  switch (seg.type) {
    case 'active':
      parts.push(`c.last_visit_at > now() - make_interval(days => ${p(seg.days ?? 30)})`);
      break;
    case 'inactive':
      parts.push(`c.last_visit_at IS NOT NULL AND c.last_visit_at < now() - make_interval(days => ${p(seg.days ?? 30)})`);
      break;
    case 'never_visited':
      parts.push('c.last_visit_at IS NULL');
      break;
    case 'new':
      parts.push(`c.created_at > now() - make_interval(days => ${p(seg.days ?? 7)})`);
      break;
    case 'near_reward':
      parts.push(`k.stamps >= (SELECT stamps_required FROM program WHERE id = 1) - ${p(seg.within ?? 2)}`);
      break;
    case 'birthday_month':
      parts.push(`extract(month FROM c.birthday) = extract(month FROM now())`);
      break;
    case 'tier':
      parts.push(`c.tier_id = ${p(seg.tierId ?? '00000000-0000-0000-0000-000000000000')}`);
      break;
    case 'tag':
      parts.push(`${p(seg.tag ?? '')} = ANY(c.tags)`);
      break;
    case 'joined_no_visit':
      // Joined a while ago and never bought anything (the welcome stamp is not a visit).
      parts.push(`c.last_visit_at IS NULL AND c.created_at < now() - make_interval(days => ${p(seg.days ?? 7)})`);
      break;
    case 'one_visit':
      parts.push(`c.visit_count = 1 AND c.last_visit_at < now() - make_interval(days => ${p(seg.days ?? 14)})`);
      break;
    case 'regulars':
      // At least 3 visits within the window.
      parts.push(
        `c.last_visit_at > now() - make_interval(days => ${p(seg.days ?? 60)}) AND (SELECT count(*) FROM stamp_events e
           WHERE e.card_id = k.id AND e.reason = 'purchase' AND e.created_at > now() - make_interval(days => ${p(seg.days ?? 60)})) >= 3`,
      );
      break;
    case 'top_spenders':
      // The top 10% of members by money spent (among those who have spent anything).
      parts.push(
        `c.total_spend > 0 AND c.total_spend >= (SELECT percentile_disc(0.9) WITHIN GROUP (ORDER BY total_spend) FROM customers WHERE total_spend > 0)`,
      );
      break;
    case 'at_risk':
      // Used to come often, then went quiet: 3+ visits, last one between N and 2N days ago.
      parts.push(
        `c.visit_count >= 3 AND c.last_visit_at < now() - make_interval(days => ${p(seg.days ?? 30)})
           AND c.last_visit_at >= now() - make_interval(days => ${p((seg.days ?? 30) * 2)})`,
      );
      break;
    case 'reward_waiting':
      parts.push(
        `EXISTS (SELECT 1 FROM vouchers v WHERE v.customer_id = c.id AND v.status = 'active'
                   AND v.expires_at > now() AND v.expires_at < now() + make_interval(days => ${p(seg.days ?? 7)}))`,
      );
      break;
    case 'referrers':
      parts.push(`EXISTS (SELECT 1 FROM customers x WHERE x.referred_by = c.id)`);
      break;
  }
  return parts.join(' AND ');
}

export async function countSegment(q: Queryable, seg: Segment): Promise<number> {
  const params: unknown[] = [];
  const where = segmentWhere(seg, params);
  const r = await one<{ n: number }>(q, `SELECT count(*)::int AS n FROM customers c JOIN cards k ON k.customer_id = c.id WHERE ${where}`, params);
  return r?.n ?? 0;
}

/** Sends a campaign: optional voucher for each recipient, then a wallet + web push message. */
export async function sendCampaign(db: Db, notifier: Notifier, campaignId: string, log: (m: string) => void) {
  const claimed = await one<{ id: string; name: string; message: string; template_id: string | null; segment: Segment }>(
    db,
    `UPDATE campaigns SET status = 'sending' WHERE id = $1 AND status IN ('draft','scheduled') RETURNING *`,
    [campaignId],
  );
  if (!claimed) return 0;
  const seg = SegmentSchema.parse(claimed.segment ?? {});
  const params: unknown[] = [];
  const where = segmentWhere(seg, params);
  const recipients = await many<{ id: string }>(
    db,
    `SELECT c.id FROM customers c JOIN cards k ON k.customer_id = c.id WHERE ${where}`,
    params,
  );
  let sent = 0;
  let next = 0;
  // A few members at a time: much faster than one by one, while leaving database connections
  // free for the shop counter.
  const worker = async () => {
    while (next < recipients.length) {
      const r = recipients[next++];
      try {
        if (claimed.template_id) await issueVoucher(db, r.id, claimed.template_id, 'campaign', claimed.id);
        await notifier.notify(r.id, { kind: 'campaign', title: claimed.name, body: claimed.message, campaignId: claimed.id });
        sent++;
      } catch (err: any) {
        log(`campaign ${claimed.id} recipient ${r.id} failed: ${err.message}`);
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, recipients.length) }, worker));
  await db.query(`UPDATE campaigns SET status = 'sent', sent_at = now(), recipients = $2 WHERE id = $1`, [claimed.id, sent]);
  log(`campaign ${claimed.name} sent to ${sent}`);
  return sent;
}
