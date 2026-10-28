import { many, one, type Queryable } from '../db.js';

// The dashboard is the heaviest page; several managers opening it at once share one calculation.
const CACHE_MS = 20_000;
const cache = new WeakMap<object, { key: string; at: number; value: Promise<Dashboard> }>();

type Dashboard = Awaited<ReturnType<typeof compute>>;

export function dashboard(q: Queryable, passTypeId: string | null, tzOffsetHours = 8): Promise<Dashboard> {
  const key = `${passTypeId}|${tzOffsetHours}`;
  const hit = cache.get(q);
  if (hit && hit.key === key && Date.now() - hit.at < CACHE_MS) return hit.value;
  const value = compute(q, passTypeId, tzOffsetHours);
  cache.set(q, { key, at: Date.now(), value });
  value.catch(() => cache.delete(q));
  return value;
}

async function compute(q: Queryable, passTypeId: string | null, tzOffsetHours: number) {
  // One pass over members for all the member counts, instead of one scan per number.
  const members = one(
    q,
    `SELECT count(*)::int AS members,
            count(*) FILTER (WHERE created_at > now() - interval '7 days')::int AS new_7d,
            count(*) FILTER (WHERE created_at > now() - interval '30 days')::int AS new_30d,
            count(*) FILTER (WHERE last_visit_at > now() - interval '30 days')::int AS active_30d,
            count(*) FILTER (WHERE visit_count >= 1)::int AS ever_visited,
            count(*) FILTER (WHERE visit_count >= 2)::int AS repeat_visitors,
            count(*) FILTER (WHERE marketing_opt_in)::int AS opted_in,
            count(*) FILTER (WHERE visit_count = 0)::int AS freq_0,
            count(*) FILTER (WHERE visit_count = 1)::int AS freq_1,
            count(*) FILTER (WHERE visit_count = 2)::int AS freq_2,
            count(*) FILTER (WHERE visit_count BETWEEN 3 AND 5)::int AS freq_3_5,
            count(*) FILTER (WHERE visit_count >= 6)::int AS freq_6
       FROM customers`,
  );
  const activity = one(
    q,
    `SELECT
       (SELECT coalesce(sum(delta), 0) FROM stamp_events WHERE created_at > now() - interval '30 days' AND delta > 0 AND reason <> 'reward_rollover')::int AS stamps_30d,
       (SELECT count(*) FROM vouchers WHERE created_at > now() - interval '30 days')::int AS vouchers_issued_30d,
       (SELECT count(*) FROM vouchers WHERE redeemed_at > now() - interval '30 days')::int AS vouchers_redeemed_30d,
       (SELECT count(*) FROM vouchers WHERE created_at > now() - interval '30 days' AND source = 'stamp_reward')::int AS cards_completed_30d,
       (SELECT count(DISTINCT serial_number) FROM apple_registrations WHERE $1::text IS NULL OR pass_type_id = $1)::int AS apple_passes,
       (SELECT count(*) FROM cards WHERE google_saved)::int AS google_passes,
       (SELECT count(DISTINCT customer_id) FROM web_push_subscriptions)::int AS web_push`,
    [passTypeId],
  );

  // Visits and money in the last 30 days, and the 30 days before that for comparison.
  const spend = one(
    q,
    `SELECT count(*) FILTER (WHERE reason = 'purchase' AND created_at > now() - interval '30 days')::int AS visits_30d,
            count(*) FILTER (WHERE reason = 'purchase' AND created_at <= now() - interval '30 days')::int AS visits_prev_30d,
            count(DISTINCT card_id) FILTER (WHERE reason = 'purchase' AND created_at > now() - interval '30 days')::int AS visitors_30d,
            coalesce(sum(amount) FILTER (WHERE created_at > now() - interval '30 days'), 0)::float8 AS spend_30d,
            coalesce(sum(amount) FILTER (WHERE created_at <= now() - interval '30 days'), 0)::float8 AS spend_prev_30d,
            count(amount) FILTER (WHERE created_at > now() - interval '30 days')::int AS bills_30d,
            avg(amount) FILTER (WHERE created_at > now() - interval '30 days')::float8 AS avg_bill_30d,
            avg(amount) FILTER (WHERE created_at <= now() - interval '30 days')::float8 AS avg_bill_prev_30d
       FROM stamp_events WHERE created_at > now() - interval '60 days'`,
  );

  const redemption = one(
    q,
    `SELECT count(*) FILTER (WHERE status = 'redeemed')::int AS redeemed, count(*)::int AS issued
       FROM vouchers WHERE created_at > now() - interval '90 days'`,
  );

  // Last 30 days in shop time (Hong Kong by default, not the server's UTC). Each table is read once
  // through its date index and grouped, rather than counted again for every day.
  const daily = many(
    q,
    `WITH b AS (
       SELECT ((now() AT TIME ZONE 'UTC') + make_interval(secs => $1::float8 * 3600))::date - 29 AS first_day
     ), w AS (
       SELECT first_day, (first_day::timestamp - make_interval(secs => $1::float8 * 3600)) AT TIME ZONE 'UTC' AS since FROM b
     ),
     s AS (SELECT ((created_at AT TIME ZONE 'UTC') + make_interval(secs => $1::float8 * 3600))::date AS d, count(*)::int AS n
             FROM customers, w WHERE created_at >= w.since GROUP BY 1),
     st AS (SELECT ((created_at AT TIME ZONE 'UTC') + make_interval(secs => $1::float8 * 3600))::date AS d, sum(delta)::int AS n
              FROM stamp_events, w WHERE created_at >= w.since AND delta > 0 AND reason <> 'reward_rollover' GROUP BY 1),
     r AS (SELECT ((redeemed_at AT TIME ZONE 'UTC') + make_interval(secs => $1::float8 * 3600))::date AS d, count(*)::int AS n
             FROM vouchers, w WHERE redeemed_at >= w.since GROUP BY 1),
     v AS (SELECT ((created_at AT TIME ZONE 'UTC') + make_interval(secs => $1::float8 * 3600))::date AS d, count(*)::int AS n,
                  coalesce(sum(amount), 0)::float8 AS spend
             FROM stamp_events, w WHERE created_at >= w.since AND reason = 'purchase' GROUP BY 1)
     SELECT to_char(days.d, 'YYYY-MM-DD') AS day,
            coalesce(s.n, 0) AS signups, coalesce(st.n, 0) AS stamps, coalesce(r.n, 0) AS redemptions,
            coalesce(v.n, 0) AS visits, coalesce(v.spend, 0) AS spend
       FROM w, generate_series(w.first_day, w.first_day + 29, interval '1 day') AS days(d)
       LEFT JOIN s ON s.d = days.d::date
       LEFT JOIN st ON st.d = days.d::date
       LEFT JOIN r ON r.d = days.d::date
       LEFT JOIN v ON v.d = days.d::date
      ORDER BY days.d`,
    [tzOffsetHours],
  );

  const distribution = many(q, `SELECT stamps, count(*)::int AS cards FROM cards GROUP BY stamps ORDER BY stamps`);

  // Monthly cohorts: of members who joined in month M, the share who visited again 30+ days after joining.
  // Members who never visited are skipped before the (costlier) look through their stamp history.
  const cohorts = many(
    q,
    `SELECT to_char(date_trunc('month', c.created_at), 'YYYY-MM') AS cohort,
            count(*)::int AS members,
            count(*) FILTER (WHERE c.visit_count >= 2)::int AS returned,
            count(*) FILTER (WHERE c.visit_count >= 1 AND c.last_visit_at > c.created_at + interval '30 days' AND EXISTS (
              SELECT 1 FROM cards k JOIN stamp_events e ON e.card_id = k.id
               WHERE k.customer_id = c.id AND e.reason = 'purchase' AND e.created_at > c.created_at + interval '30 days'))::int AS retained_30d
       FROM customers c
      WHERE c.created_at > now() - interval '6 months'
      GROUP BY 1 ORDER BY 1`,
  );

  const sources = many(
    q,
    `SELECT source, count(*)::int AS issued, count(*) FILTER (WHERE status = 'redeemed')::int AS redeemed
       FROM vouchers WHERE created_at > now() - interval '90 days' GROUP BY source ORDER BY issued DESC`,
  );

  // All at once (each on its own pooled connection); Promise.all also handles a failure in any of them.
  const [m, a, sp, red, day, dist, coh, src] = await Promise.all([members, activity, spend, redemption, daily, distribution, cohorts, sources]);
  return { totals: { ...m, ...a }, spend: sp, redemption: red, daily: day, distribution: dist, cohorts: coh, sources: src };
}
