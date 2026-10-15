import { many, one, type Db } from '../db.js';
import type { Config } from '../config.js';
import { issueVoucher } from './loyalty.js';
import type { Notifier } from './notify.js';
import { getProgram } from './program.js';
import { sendCampaign } from './campaigns.js';
import { listTiers, reevaluateTier } from './tiers.js';

const LOCK_ID = 77001;
// Daily automations wait until this local hour so pushes never land overnight.
const DAILY_HOUR = 10;

function localNow(cfg: Config) {
  const d = new Date(Date.now() + cfg.tzOffsetHours * 3600_000);
  return { date: d.toISOString().slice(0, 10), year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours() };
}

async function once(db: Db, job: string, key: string): Promise<boolean> {
  const r = await db.query('INSERT INTO job_runs (job, run_key) VALUES ($1,$2) ON CONFLICT DO NOTHING', [job, key]);
  return r.rowCount === 1;
}

export async function runBirthdays(db: Db, cfg: Config, notifier: Notifier, log: (m: string) => void) {
  const program = await getProgram(db);
  if (!program.birthday_enabled || !program.birthday_template_id) return 0;
  const t = localNow(cfg);
  const people = await many<{ id: string }>(
    db,
    `SELECT id FROM customers
      WHERE birthday IS NOT NULL AND extract(month FROM birthday) = $1 AND extract(day FROM birthday) = $2
        AND (last_birthday_reward_year IS NULL OR last_birthday_reward_year < $3)`,
    [t.month, t.day, t.year],
  );
  for (const p of people) {
    const claimed = await one(db, `UPDATE customers SET last_birthday_reward_year = $2 WHERE id = $1 AND (last_birthday_reward_year IS NULL OR last_birthday_reward_year < $2) RETURNING id`, [p.id, t.year]);
    if (!claimed) continue;
    await issueVoucher(db, p.id, program.birthday_template_id, 'birthday');
    await notifier.notify(p.id, { kind: 'birthday', title: 'Happy birthday!', body: program.birthday_message });
  }
  if (people.length) log(`birthday rewards: ${people.length}`);
  return people.length;
}

export async function runWinback(db: Db, notifier: Notifier, log: (m: string) => void) {
  const program = await getProgram(db);
  if (!program.winback_enabled) return 0;
  const people = await many<{ id: string }>(
    db,
    `SELECT id FROM customers
      WHERE marketing_opt_in
        AND coalesce(last_visit_at, created_at) < now() - make_interval(days => $1)
        AND (last_winback_at IS NULL OR last_winback_at < coalesce(last_visit_at, created_at))
      LIMIT 2000`,
    [program.winback_days],
  );
  for (const p of people) {
    await db.query('UPDATE customers SET last_winback_at = now() WHERE id = $1', [p.id]);
    if (program.winback_template_id) await issueVoucher(db, p.id, program.winback_template_id, 'winback');
    await notifier.notify(p.id, { kind: 'winback', title: 'We miss you', body: program.winback_message });
  }
  if (people.length) log(`win-back messages: ${people.length}`);
  return people.length;
}

/** Nudges members who are close to a free reward but have not been in for a while. */
export async function runNearReward(db: Db, notifier: Notifier, log: (m: string) => void) {
  const program = await getProgram(db);
  if (!program.near_reward_enabled) return 0;
  const people = await many<{ id: string; left: number }>(
    db,
    `SELECT c.id, ($1 - k.stamps)::int AS left FROM customers c JOIN cards k ON k.customer_id = c.id
      WHERE c.marketing_opt_in AND k.stamps > 0 AND k.stamps >= $1 - $2
        AND c.last_visit_at < now() - make_interval(days => $3)
        AND (c.last_near_reward_at IS NULL OR c.last_near_reward_at < c.last_visit_at)
      LIMIT 2000`,
    [program.stamps_required, program.near_reward_within, program.near_reward_after_days],
  );
  for (const p of people) {
    await db.query('UPDATE customers SET last_near_reward_at = now() WHERE id = $1', [p.id]);
    await notifier.notify(p.id, {
      kind: 'near_reward',
      title: p.left === 1 ? 'Just 1 stamp to go' : `Just ${p.left} stamps to go`,
      body: program.near_reward_message,
    });
  }
  if (people.length) log(`near-reward nudges: ${people.length}`);
  return people.length;
}

/** Daily tier check: members whose rolling stamp count dropped move down a tier (quietly). */
export async function runTierReview(db: Db, notifier: Notifier, log: (m: string) => void) {
  const program = await getProgram(db);
  if (!program.tiers_enabled) return 0;
  const tiers = await listTiers(db);
  const people = await many<{ id: string }>(
    db,
    `SELECT c.id FROM customers c LEFT JOIN tiers t ON t.id = c.tier_id WHERE c.tier_id IS NULL OR t.min_stamps > 0`,
  );
  let changed = 0;
  for (const p of people) {
    const ch = await reevaluateTier(db, p.id, program.tier_window_days, tiers);
    if (ch) {
      changed++;
      await notifier.passChanged(p.id);
    }
  }
  if (changed) log(`tier changes: ${changed}`);
  return changed;
}

export async function runExpiry(db: Db, notifier: Notifier, log: (m: string) => void) {
  const program = await getProgram(db);
  const expired = await db.query(`UPDATE vouchers SET status = 'expired' WHERE status = 'active' AND expires_at < now() RETURNING customer_id`);
  const touched = [...new Set(expired.rows.map((r) => r.customer_id as string))];
  for (const c of touched) {
    await db.query('UPDATE cards SET updated_at = now() WHERE customer_id = $1', [c]);
    await notifier.passChanged(c);
  }
  const soon = await many<{ customer_id: string; title: string; n: number }>(
    db,
    `WITH due AS (
       UPDATE vouchers v SET reminder_sent_at = now()
        WHERE status = 'active' AND reminder_sent_at IS NULL
          AND expires_at < now() + make_interval(days => $1) AND expires_at > now()
        RETURNING v.customer_id, v.template_id)
     SELECT d.customer_id, min(t.title) AS title, count(*)::int AS n
       FROM due d JOIN voucher_templates t ON t.id = d.template_id GROUP BY d.customer_id`,
    [program.expiry_reminder_days],
  );
  for (const s of soon) {
    const body = s.n > 1 ? `${s.n} rewards expire soon. Come in and use them!` : `Your ${s.title} expires soon. Come in and use it!`;
    await notifier.notify(s.customer_id, { kind: 'expiry', title: 'Use it before it melts', body });
  }
  if (expired.rowCount || soon.length) log(`vouchers expired: ${expired.rowCount}, reminders: ${soon.length}`);
}

export async function tick(db: Db, cfg: Config, notifier: Notifier, log: (m: string) => void) {
  const client = await db.connect();
  try {
    const { rows } = await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_ID]);
    if (!rows[0].ok) return; // another instance is running jobs
    try {
      const due = await many<{ id: string }>(db, `SELECT id FROM campaigns WHERE status = 'scheduled' AND scheduled_at <= now()`);
      for (const c of due) await sendCampaign(db, notifier, c.id, log);

      const t = localNow(cfg);
      if (t.hour >= DAILY_HOUR && (await once(db, 'daily', t.date))) {
        await runBirthdays(db, cfg, notifier, log);
        await runWinback(db, notifier, log);
        await runNearReward(db, notifier, log);
        await runTierReview(db, notifier, log);
        await runExpiry(db, notifier, log);
        await db.query(`DELETE FROM otp_codes WHERE created_at < now() - interval '2 days'`);
        await db.query(`DELETE FROM apple_logs WHERE created_at < now() - interval '30 days'`);
      }
    } finally {
      await client.query('SELECT pg_advisory_unlock($1)', [LOCK_ID]);
    }
  } catch (err: any) {
    log(`jobs tick failed: ${err.message}`);
  } finally {
    client.release();
  }
}

export function startJobs(db: Db, cfg: Config, notifier: Notifier, log: (m: string) => void): () => void {
  const timer = setInterval(() => void tick(db, cfg, notifier, log), 60_000);
  void tick(db, cfg, notifier, log);
  return () => clearInterval(timer);
}
