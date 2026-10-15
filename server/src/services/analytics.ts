import { many, one, type Queryable } from '../db.js';

export async function dashboard(q: Queryable, passTypeId: string | null) {
  const totals = await one(
    q,
    `SELECT
       (SELECT count(*) FROM customers)::int AS members,
       (SELECT count(*) FROM customers WHERE created_at > now() - interval '7 days')::int AS new_7d,
       (SELECT count(*) FROM customers WHERE created_at > now() - interval '30 days')::int AS new_30d,
       (SELECT count(*) FROM customers WHERE last_visit_at > now() - interval '30 days')::int AS active_30d,
       (SELECT count(*) FROM customers WHERE visit_count >= 1)::int AS ever_visited,
       (SELECT count(*) FROM customers WHERE visit_count >= 2)::int AS repeat_visitors,
       (SELECT count(*) FROM customers WHERE marketing_opt_in)::int AS opted_in,
       (SELECT coalesce(sum(delta), 0) FROM stamp_events WHERE delta > 0 AND reason <> 'reward_rollover' AND created_at > now() - interval '30 days')::int AS stamps_30d,
       (SELECT count(*) FROM vouchers WHERE created_at > now() - interval '30 days')::int AS vouchers_issued_30d,
       (SELECT count(*) FROM vouchers WHERE redeemed_at > now() - interval '30 days')::int AS vouchers_redeemed_30d,
       (SELECT count(*) FROM vouchers WHERE source = 'stamp_reward' AND created_at > now() - interval '30 days')::int AS cards_completed_30d,
       (SELECT count(DISTINCT serial_number) FROM apple_registrations WHERE $1::text IS NULL OR pass_type_id = $1)::int AS apple_passes,
       (SELECT count(*) FROM cards WHERE google_saved)::int AS google_passes,
       (SELECT count(DISTINCT customer_id) FROM web_push_subscriptions)::int AS web_push`,
    [passTypeId],
  );

  const redemption = await one(
    q,
    `SELECT count(*) FILTER (WHERE status = 'redeemed')::int AS redeemed, count(*)::int AS issued
       FROM vouchers WHERE created_at > now() - interval '90 days'`,
  );

  const daily = await many(
    q,
    `WITH days AS (SELECT generate_series((now() - interval '29 days')::date, now()::date, interval '1 day')::date AS d)
     SELECT to_char(d, 'YYYY-MM-DD') AS day,
       (SELECT count(*) FROM customers WHERE created_at::date = d)::int AS signups,
       (SELECT coalesce(sum(delta),0) FROM stamp_events WHERE delta > 0 AND reason <> 'reward_rollover' AND created_at::date = d)::int AS stamps,
       (SELECT count(*) FROM vouchers WHERE redeemed_at::date = d)::int AS redemptions
     FROM days ORDER BY d`,
  );

  const distribution = await many(
    q,
    `SELECT stamps, count(*)::int AS cards FROM cards GROUP BY stamps ORDER BY stamps`,
  );

  // Monthly cohorts: of members who joined in month M, the share who visited again 30+ days after joining.
  const cohorts = await many(
    q,
    `SELECT to_char(date_trunc('month', c.created_at), 'YYYY-MM') AS cohort,
            count(*)::int AS members,
            count(*) FILTER (WHERE c.visit_count >= 2)::int AS returned,
            count(*) FILTER (WHERE EXISTS (
              SELECT 1 FROM stamp_events e JOIN cards k ON k.id = e.card_id
               WHERE k.customer_id = c.id AND e.reason = 'purchase' AND e.created_at > c.created_at + interval '30 days'))::int AS retained_30d
       FROM customers c
      WHERE c.created_at > now() - interval '6 months'
      GROUP BY 1 ORDER BY 1`,
  );

  const sources = await many(
    q,
    `SELECT source, count(*)::int AS issued, count(*) FILTER (WHERE status = 'redeemed')::int AS redeemed
       FROM vouchers WHERE created_at > now() - interval '90 days' GROUP BY source ORDER BY issued DESC`,
  );

  return { totals, redemption, daily, distribution, cohorts, sources };
}
