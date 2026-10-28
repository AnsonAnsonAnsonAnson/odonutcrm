import { one, withTx, type Db } from './db.js';
import { hashPassword } from './lib/crypto.js';

/** Idempotent first-run data: program settings, starter vouchers, a store, and the first owner. */
export async function seed(db: Db, opts: { adminEmail?: string; adminPassword?: string; log?: (m: string) => void }) {
  const log = opts.log ?? console.log;
  await withTx(db, async (tx) => {
    const exists = await one(tx, 'SELECT 1 FROM program WHERE id = 1');
    if (!exists) {
      const t = async (title: string, description: string, kind: string, value: number, days: number) =>
        (await one<{ id: string }>(
          tx,
          `INSERT INTO voucher_templates (title, description, kind, value, valid_days) VALUES ($1,$2,$3,$4,$5) RETURNING id`,
          [title, description, kind, value, days],
        ))!.id;
      const reward = await t('2 Free Donuts', 'You completed your stamp card! Two classic donuts on us, used together in one visit.', 'free_item', 0, 60);
      const welcome = await t('Free Cream Cheese Donut', 'Welcome to the club! Enjoy a free cream cheese donut on us.', 'free_item', 0, 30);
      const birthday = await t('Birthday Donut', 'Happy birthday! Enjoy a free donut of your choice this month.', 'free_item', 0, 30);
      const winback = await t('$5 Cash Voucher', '$5 off any order. We miss you!', 'cash', 5, 14);
      const referral = await t('Friend Reward: Free Donut', 'Thanks for bringing a friend to O! Donut.', 'free_item', 0, 30);
      await tx.query(
        `INSERT INTO program (id, reward_template_id, welcome_template_id, birthday_template_id, winback_template_id, referral_template_id, terms)
         VALUES (1, $1, $2, $3, $4, $5, $6)`,
        [
          reward,
          welcome,
          birthday,
          winback,
          referral,
          'Collect 1 stamp for every $40 spent in one purchase. 10 stamps earn 2 free donuts. Rewards are single use and cannot be exchanged for cash.',
        ],
      );
      await tx.query(`INSERT INTO stores (name, address) VALUES ('O! Donut Flagship', 'Hong Kong')`);
      await tx.query(
        `INSERT INTO promo_codes (code, template_id, max_uses) VALUES ('HELLODONUT', $1, 500)`,
        [welcome],
      );
      log('seeded program, voucher templates, store and promo code HELLODONUT');
    }
    const anyStaff = await one(tx, 'SELECT 1 FROM staff_users LIMIT 1');
    if (!anyStaff && opts.adminEmail && opts.adminPassword) {
      await tx.query(`INSERT INTO staff_users (email, name, role, password_hash) VALUES ($1, 'Owner', 'owner', $2)`, [
        opts.adminEmail.toLowerCase(),
        await hashPassword(opts.adminPassword),
      ]);
      log(`created owner account ${opts.adminEmail}`);
    } else if (!anyStaff) {
      log('No staff accounts yet. Set ADMIN_EMAIL and ADMIN_PASSWORD and restart to create the owner.');
    }
  });
}
