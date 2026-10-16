import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { many, one } from '../db.js';
import { HttpError } from '../lib/auth.js';
import { hashPassword } from '../lib/crypto.js';
import { dashboard } from '../services/analytics.js';
import { SegmentSchema, countSegment, sendCampaign } from '../services/campaigns.js';
import { addStamps, customerHistory, customerVouchers, issueVoucher } from '../services/loyalty.js';
import { getProgram } from '../services/program.js';
import { afterStamp, staffGuard } from './staff.js';
import { newApiKey } from './pos.js';
import { listTiers } from '../services/tiers.js';
import { checkAppleCert } from '../lib/certs.js';
import { explainMailError } from '../lib/mailer.js';
import { appleSetupStatus, createSigningRequest, installCertificate, removeStoredCredentials } from '../services/apple/credentials.js';

const uuid = z.string().uuid();
const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);

function csvCell(v: unknown): string {
  let s = v === null || v === undefined ? '' : v instanceof Date ? v.toISOString() : String(v);
  // Neutralise spreadsheet formula injection.
  if (/^[=+\-@]/.test(s)) s = `'${s}`;
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export async function adminRoutes(app: FastifyInstance) {
  const svc = app.svc;
  const { db, cfg, notifier, log } = svc;
  const manager = staffGuard(svc, 'manager');
  const owner = staffGuard(svc, 'owner');

  app.get('/dashboard', async (req) => {
    await manager(req);
    return dashboard(db, cfg.apple?.passTypeId ?? null);
  });

  // ---------- Customers ----------
  app.get('/customers', async (req) => {
    await manager(req);
    const q = z
      .object({
        q: z.string().trim().max(100).optional(),
        page: z.coerce.number().int().min(1).default(1),
        sort: z.enum(['recent', 'visits', 'stamps', 'last_visit']).default('recent'),
      })
      .parse(req.query);
    const order = {
      recent: 'c.created_at DESC',
      visits: 'c.visit_count DESC',
      stamps: 'k.stamps DESC',
      last_visit: 'c.last_visit_at DESC NULLS LAST',
    }[q.sort];
    const params: unknown[] = [];
    let where = 'true';
    if (q.q) {
      params.push(`%${q.q.toLowerCase()}%`);
      where = `(lower(c.email) LIKE $1 OR lower(c.first_name || ' ' || c.last_name) LIKE $1 OR c.phone LIKE $1)`;
    }
    params.push((q.page - 1) * 50);
    const rows = await many(
      db,
      `SELECT c.id, c.first_name, c.last_name, c.email, c.phone, c.created_at, c.last_visit_at, c.visit_count,
              c.marketing_opt_in, c.tags, k.stamps, k.rewards_earned, t.name AS tier,
              EXISTS (SELECT 1 FROM apple_registrations r WHERE r.serial_number = k.serial_number) AS apple_saved, k.google_saved
         FROM customers c JOIN cards k ON k.customer_id = c.id LEFT JOIN tiers t ON t.id = c.tier_id
        WHERE ${where} ORDER BY ${order} LIMIT 50 OFFSET $${params.length}`,
      params,
    );
    const total = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM customers c WHERE ${where}`, params.slice(0, -1));
    return { rows, total: total?.n ?? 0 };
  });

  app.get('/customers.csv', async (req, reply) => {
    await owner(req);
    const rows = await many(
      db,
      `SELECT c.first_name, c.last_name, c.email, c.phone, c.birthday, c.gender, c.marketing_opt_in, c.created_at,
              c.last_visit_at, c.visit_count, k.stamps, k.lifetime_stamps, k.rewards_earned, array_to_string(c.tags, ';') AS tags
         FROM customers c JOIN cards k ON k.customer_id = c.id ORDER BY c.created_at`,
    );
    const cols = rows.length ? Object.keys(rows[0]) : ['email'];
    const csv = [cols.join(','), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(','))].join('\n');
    return reply.header('content-type', 'text/csv').header('content-disposition', 'attachment; filename="members.csv"').send(csv);
  });

  app.get('/customers/:id', async (req) => {
    await manager(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const c = await one(
      db,
      `SELECT c.*, k.id AS card_id, k.serial_number, k.stamps, k.lifetime_stamps, k.rewards_earned, k.google_saved,
              EXISTS (SELECT 1 FROM apple_registrations r WHERE r.serial_number = k.serial_number) AS apple_saved,
              EXISTS (SELECT 1 FROM web_push_subscriptions w WHERE w.customer_id = c.id) AS web_push,
              rc.first_name || ' ' || rc.last_name AS referred_by_name, tr.name AS tier,
              (SELECT count(*)::int FROM customers x WHERE x.referred_by = c.id) AS referrals
         FROM customers c JOIN cards k ON k.customer_id = c.id LEFT JOIN customers rc ON rc.id = c.referred_by
         LEFT JOIN tiers tr ON tr.id = c.tier_id
        WHERE c.id = $1`,
      [id],
    );
    if (!c) throw new HttpError(404, 'Customer not found');
    const [vouchers, history, notifications] = await Promise.all([
      customerVouchers(db, id),
      customerHistory(db, id),
      many(db, 'SELECT kind, title, body, channels, created_at FROM notifications WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 50', [id]),
    ]);
    return { customer: c, vouchers, history, notifications };
  });

  app.patch('/customers/:id', async (req) => {
    await manager(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z
      .object({
        tags: z.array(z.string().trim().min(1).max(30)).max(20).optional(),
        notes: z.string().max(2000).optional(),
        marketingOptIn: z.boolean().optional(),
      })
      .parse(req.body);
    await db.query(
      `UPDATE customers SET tags = coalesce($2, tags), notes = coalesce($3, notes), marketing_opt_in = coalesce($4, marketing_opt_in) WHERE id = $1`,
      [id, b.tags ?? null, b.notes ?? null, b.marketingOptIn ?? null],
    );
    return { ok: true };
  });

  app.delete('/customers/:id', async (req) => {
    await owner(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await db.query('DELETE FROM customers WHERE id = $1', [id]);
    return { ok: true };
  });

  app.post('/customers/:id/stamps', async (req) => {
    const s = await manager(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ delta: z.number().int().min(-50).max(50).refine((n) => n !== 0), note: z.string().trim().min(1).max(200) }).parse(req.body);
    const card = await one<{ id: string }>(db, 'SELECT id FROM cards WHERE customer_id = $1', [id]);
    if (!card) throw new HttpError(404, 'Card not found');
    const r = await addStamps(db, {
      cardId: card.id,
      count: b.delta,
      reason: b.delta > 0 ? 'bonus' : 'adjustment',
      staffId: s.id,
      storeId: s.storeId,
      note: b.note,
      bypassLimits: true,
    });
    void afterStamp(svc, r);
    return { stamps: r.card.stamps, rewards: r.rewards.length };
  });

  app.post('/customers/:id/vouchers', async (req) => {
    await manager(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ templateId: uuid, notify: z.boolean().default(true) }).parse(req.body);
    const v = await issueVoucher(db, id, b.templateId, 'manual');
    if (!v) throw new HttpError(400, 'That voucher template is inactive');
    if (b.notify) {
      void notifier.notify(id, { kind: 'manual', title: 'A gift for you', body: `${v.title} is waiting in your Member Center.` }).catch(() => {});
    } else {
      await db.query('UPDATE cards SET updated_at = now() WHERE customer_id = $1', [id]);
      void notifier.passChanged(id).catch(() => {});
    }
    return v;
  });

  app.post('/customers/:id/message', async (req) => {
    await manager(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ title: z.string().trim().min(1).max(60), body: z.string().trim().min(1).max(240) }).parse(req.body);
    const channels = await notifier.notify(id, { kind: 'manual', ...b });
    return { channels };
  });

  app.post('/vouchers/:code/void', async (req) => {
    await manager(req);
    const { code } = z.object({ code: z.string().max(40) }).parse(req.params);
    const v = await one<{ customer_id: string }>(
      db,
      `UPDATE vouchers SET status = 'void' WHERE code = $1 AND status = 'active' RETURNING customer_id`,
      [code.toUpperCase()],
    );
    if (!v) throw new HttpError(404, 'No active voucher with that code');
    await db.query('UPDATE cards SET updated_at = now() WHERE customer_id = $1', [v.customer_id]);
    void notifier.passChanged(v.customer_id).catch(() => {});
    return { ok: true };
  });

  // ---------- Voucher templates ----------
  const templateBody = z.object({
    title: z.string().trim().min(1).max(60),
    description: z.string().trim().max(300).default(''),
    kind: z.enum(['free_item', 'cash', 'percent']),
    value: z.number().min(0).max(100000).default(0),
    validDays: z.number().int().min(1).max(3650),
    active: z.boolean().default(true),
  });

  app.get('/templates', async (req) => {
    await manager(req);
    return many(
      db,
      `SELECT t.*, (SELECT count(*)::int FROM vouchers v WHERE v.template_id = t.id) AS issued,
              (SELECT count(*)::int FROM vouchers v WHERE v.template_id = t.id AND v.status = 'redeemed') AS redeemed
         FROM voucher_templates t ORDER BY t.created_at`,
    );
  });
  app.post('/templates', async (req) => {
    await owner(req);
    const b = templateBody.parse(req.body);
    return one(
      db,
      `INSERT INTO voucher_templates (title, description, kind, value, valid_days, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [b.title, b.description, b.kind, b.value, b.validDays, b.active],
    );
  });
  app.patch('/templates/:id', async (req) => {
    await owner(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = templateBody.parse(req.body);
    return one(
      db,
      `UPDATE voucher_templates SET title=$2, description=$3, kind=$4, value=$5, valid_days=$6, active=$7 WHERE id=$1 RETURNING *`,
      [id, b.title, b.description, b.kind, b.value, b.validDays, b.active],
    );
  });

  // ---------- Promo codes ----------
  app.get('/promos', async (req) => {
    await manager(req);
    return many(db, `SELECT p.*, t.title AS template_title FROM promo_codes p JOIN voucher_templates t ON t.id = p.template_id ORDER BY p.created_at DESC`);
  });
  app.post('/promos', async (req) => {
    await owner(req);
    const b = z
      .object({
        code: z.string().trim().toUpperCase().regex(/^[A-Z0-9_-]{3,30}$/, 'Use 3-30 letters, numbers, - or _'),
        templateId: uuid,
        maxUses: z.number().int().min(1).nullable().default(null),
        startsAt: z.string().datetime({ offset: true }).nullable().default(null),
        endsAt: z.string().datetime({ offset: true }).nullable().default(null),
      })
      .parse(req.body);
    return one(
      db,
      `INSERT INTO promo_codes (code, template_id, max_uses, starts_at, ends_at) VALUES ($1,$2,$3,$4,$5) RETURNING *`,
      [b.code, b.templateId, b.maxUses, b.startsAt, b.endsAt],
    );
  });
  app.patch('/promos/:id', async (req) => {
    await owner(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z.object({ active: z.boolean() }).parse(req.body);
    return one(db, 'UPDATE promo_codes SET active = $2 WHERE id = $1 RETURNING *', [id, b.active]);
  });

  // ---------- Campaigns ----------
  app.get('/campaigns', async (req) => {
    await manager(req);
    return many(
      db,
      `SELECT c.*, t.title AS template_title,
              (SELECT count(*)::int FROM vouchers v WHERE v.source = 'campaign' AND v.source_ref = c.id AND v.status = 'redeemed') AS redeemed
         FROM campaigns c LEFT JOIN voucher_templates t ON t.id = c.template_id ORDER BY c.created_at DESC LIMIT 100`,
    );
  });
  app.post('/campaigns/preview', async (req) => {
    await manager(req);
    const seg = SegmentSchema.parse(req.body);
    return { recipients: await countSegment(db, seg) };
  });
  app.post('/campaigns', async (req) => {
    const s = await owner(req);
    const b = z
      .object({
        name: z.string().trim().min(1).max(60),
        message: z.string().trim().min(1).max(240),
        templateId: uuid.nullable().default(null),
        segment: SegmentSchema,
        scheduledAt: z.string().datetime({ offset: true }).nullable().default(null),
      })
      .parse(req.body);
    return one(
      db,
      `INSERT INTO campaigns (name, message, template_id, segment, status, scheduled_at, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [b.name, b.message, b.templateId, b.segment, b.scheduledAt ? 'scheduled' : 'draft', b.scheduledAt, s.id],
    );
  });
  app.post('/campaigns/:id/send', async (req) => {
    await owner(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const c = await one<{ status: string }>(db, 'SELECT status FROM campaigns WHERE id = $1', [id]);
    if (!c) throw new HttpError(404, 'Campaign not found');
    if (!['draft', 'scheduled'].includes(c.status)) throw new HttpError(409, `Campaign is already ${c.status}`);
    // Send in the background; the list shows progress via status.
    void sendCampaign(db, notifier, id, log).catch((err) => log(`campaign send failed: ${err.message}`));
    return { ok: true };
  });
  app.post('/campaigns/:id/cancel', async (req) => {
    await owner(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await db.query(`UPDATE campaigns SET status = 'cancelled' WHERE id = $1 AND status IN ('draft','scheduled')`, [id]);
    return { ok: true };
  });

  // ---------- Email check ----------
  app.post('/test-email', async (req) => {
    const me = await manager(req);
    const u = await one<{ email: string }>(db, 'SELECT email FROM staff_users WHERE id = $1', [me.id]);
    if (!cfg.smtp) {
      throw new HttpError(409, 'Email is not set up yet: the site has no SMTP_HOST setting. Check the setting names in Netlify (or .env), then deploy or restart again.');
    }
    try {
      await svc.mailer.send(u!.email, 'O! Donut test email', 'This is a test from your O! Donut Club admin page. Email is working.');
    } catch (err) {
      throw new HttpError(502, explainMailError(err));
    }
    return { ok: true, to: u!.email };
  });

  // ---------- Apple Wallet setup wizard (owner) ----------
  app.get('/apple-wallet', async (req) => {
    await owner(req);
    return appleSetupStatus(db, cfg);
  });
  app.post('/apple-wallet/csr', async (req) => {
    const me = await owner(req);
    const u = await one<{ email: string }>(db, 'SELECT email FROM staff_users WHERE id = $1', [me.id]);
    return { csr: await createSigningRequest(db, cfg, u?.email ?? 'owner@example.com') };
  });
  app.post('/apple-wallet/certificate', async (req) => {
    await owner(req);
    const b = z.object({ certificate: z.string().min(100).max(20_000) }).parse(req.body);
    const apple = await installCertificate(db, cfg, Buffer.from(b.certificate, 'base64'));
    notifier.appleChanged();
    log(`apple wallet activated for ${apple.passTypeId}`);
    return appleSetupStatus(db, cfg);
  });
  app.delete('/apple-wallet', async (req) => {
    await owner(req);
    await removeStoredCredentials(db, cfg);
    notifier.appleChanged();
    return appleSetupStatus(db, cfg);
  });

  // ---------- Program settings & automations ----------
  app.get('/program', async (req) => {
    await manager(req);
    return {
      program: await getProgram(db),
      integrations: {
        appleWallet: !!cfg.apple,
        googleWallet: !!cfg.google,
        webPush: !!cfg.vapid,
        email: !!cfg.smtp,
        // 'log' = test mode (codes written to the server log), 'off' = production without SMTP.
        emailMode: cfg.smtp ? 'smtp' : cfg.isProd ? 'off' : 'log',
        sms: !!cfg.twilio,
        appleCert: cfg.apple ? checkAppleCert(cfg.apple) : null,
        publicUrl: cfg.publicUrl,
        httpsReady: cfg.publicUrl.startsWith('https://'),
      },
    };
  });
  app.patch('/program', async (req) => {
    await owner(req);
    const b = z
      .object({
        name: z.string().trim().min(1).max(60),
        brand_name: z.string().trim().min(1).max(40),
        stamps_required: z.number().int().min(2).max(20),
        max_stamps_per_scan: z.number().int().min(1).max(20),
        stamp_cooldown_seconds: z.number().int().min(0).max(86400),
        background_color: hex,
        foreground_color: hex,
        label_color: hex,
        reward_template_id: uuid.nullable(),
        welcome_template_id: uuid.nullable(),
        birthday_enabled: z.boolean(),
        birthday_template_id: uuid.nullable(),
        birthday_message: z.string().trim().min(1).max(240),
        winback_enabled: z.boolean(),
        winback_days: z.number().int().min(7).max(365),
        winback_template_id: uuid.nullable(),
        winback_message: z.string().trim().min(1).max(240),
        referral_enabled: z.boolean(),
        referral_template_id: uuid.nullable(),
        expiry_reminder_days: z.number().int().min(0).max(30),
        terms: z.string().trim().min(1).max(2000),
        tiers_enabled: z.boolean(),
        tier_window_days: z.number().int().min(30).max(3650),
        near_reward_enabled: z.boolean(),
        near_reward_within: z.number().int().min(1).max(5),
        near_reward_after_days: z.number().int().min(1).max(90),
        near_reward_message: z.string().trim().min(1).max(240),
        welcome_email_enabled: z.boolean(),
        privacy_policy: z.string().max(20000),
        stamp_multiplier: z.number().int().min(1).max(5),
        multiplier_starts_at: z.string().datetime({ offset: true }).nullable(),
        multiplier_ends_at: z.string().datetime({ offset: true }).nullable(),
        multiplier_label: z.string().trim().min(1).max(40),
      })
      .partial()
      .parse(req.body);
    const keys = Object.keys(b) as (keyof typeof b)[];
    if (keys.length) {
      const sets = keys.map((k, i) => `${k} = $${i + 1}`).join(', ');
      await db.query(`UPDATE program SET ${sets}, updated_at = now() WHERE id = 1`, keys.map((k) => b[k]));
    }
    // Look changes show on every pass. Touch cards so wallets refresh on their next check.
    const visual = ['name', 'brand_name', 'stamps_required', 'background_color', 'foreground_color', 'label_color', 'terms'];
    if (keys.some((k) => visual.includes(k))) await db.query('UPDATE cards SET updated_at = now()');
    return getProgram(db);
  });
  app.post('/program/google-sync', async (req) => {
    await owner(req);
    if (!notifier.google) throw new HttpError(400, 'Google Wallet is not configured');
    await notifier.google.upsertClass(await getProgram(db));
    return { ok: true };
  });

  // ---------- Tiers ----------
  const tierBody = z.object({
    name: z.string().trim().min(1).max(30),
    minStamps: z.number().int().min(0).max(10000),
    perks: z.string().trim().max(300).default(''),
    upgradeTemplateId: uuid.nullable().default(null),
    color: hex.default('#3B1F14'),
  });
  app.get('/tiers', async (req) => {
    await manager(req);
    return many(
      db,
      `SELECT t.*, vt.title AS upgrade_title, (SELECT count(*)::int FROM customers c WHERE c.tier_id = t.id) AS members
         FROM tiers t LEFT JOIN voucher_templates vt ON vt.id = t.upgrade_template_id ORDER BY t.min_stamps`,
    );
  });
  app.post('/tiers', async (req) => {
    await owner(req);
    const b = tierBody.parse(req.body);
    return one(db, `INSERT INTO tiers (name, min_stamps, perks, upgrade_template_id, color) VALUES ($1,$2,$3,$4,$5) RETURNING *`, [
      b.name, b.minStamps, b.perks, b.upgradeTemplateId, b.color,
    ]);
  });
  app.patch('/tiers/:id', async (req) => {
    await owner(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = tierBody.parse(req.body);
    return one(db, `UPDATE tiers SET name=$2, min_stamps=$3, perks=$4, upgrade_template_id=$5, color=$6 WHERE id=$1 RETURNING *`, [
      id, b.name, b.minStamps, b.perks, b.upgradeTemplateId, b.color,
    ]);
  });
  app.delete('/tiers/:id', async (req) => {
    await owner(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const t = await one<{ min_stamps: number }>(db, 'SELECT min_stamps FROM tiers WHERE id = $1', [id]);
    if (t?.min_stamps === 0 && (await listTiers(db)).length > 1) throw new HttpError(400, 'Delete the higher tiers first, or rename the starting tier instead');
    await db.query('DELETE FROM tiers WHERE id = $1', [id]);
    return { ok: true };
  });

  // ---------- POS API keys ----------
  app.get('/api-keys', async (req) => {
    await owner(req);
    return many(
      db,
      `SELECT k.id, k.name, k.prefix, k.created_at, k.last_used_at, k.revoked_at, s.name AS store_name
         FROM api_keys k LEFT JOIN stores s ON s.id = k.store_id ORDER BY k.created_at DESC`,
    );
  });
  app.post('/api-keys', async (req) => {
    const s = await owner(req);
    const b = z.object({ name: z.string().trim().min(1).max(60), storeId: uuid.nullable().default(null) }).parse(req.body);
    const k = newApiKey();
    const row = await one(
      db,
      `INSERT INTO api_keys (name, prefix, key_hash, store_id, created_by) VALUES ($1,$2,$3,$4,$5) RETURNING id, name, prefix, created_at`,
      [b.name, k.prefix, k.hash, b.storeId, s.id],
    );
    // The full key is shown once and never stored.
    return { ...row, key: k.key };
  });
  app.delete('/api-keys/:id', async (req) => {
    await owner(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    await db.query('UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND revoked_at IS NULL', [id]);
    return { ok: true };
  });

  // ---------- Stores ----------
  const storeBody = z.object({
    name: z.string().trim().min(1).max(80),
    address: z.string().trim().max(200).nullable().default(null),
    latitude: z.number().min(-90).max(90).nullable().default(null),
    longitude: z.number().min(-180).max(180).nullable().default(null),
    relevantText: z.string().trim().max(100).nullable().default(null),
    active: z.boolean().default(true),
  });
  app.get('/stores', async (req) => {
    await manager(req);
    return many(db, 'SELECT * FROM stores ORDER BY created_at');
  });
  app.post('/stores', async (req) => {
    await owner(req);
    const b = storeBody.parse(req.body);
    return one(
      db,
      'INSERT INTO stores (name, address, latitude, longitude, relevant_text, active) VALUES ($1,$2,$3,$4,$5,$6) RETURNING *',
      [b.name, b.address, b.latitude, b.longitude, b.relevantText, b.active],
    );
  });
  app.patch('/stores/:id', async (req) => {
    await owner(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = storeBody.parse(req.body);
    return one(
      db,
      'UPDATE stores SET name=$2, address=$3, latitude=$4, longitude=$5, relevant_text=$6, active=$7 WHERE id=$1 RETURNING *',
      [id, b.name, b.address, b.latitude, b.longitude, b.relevantText, b.active],
    );
  });

  // ---------- Staff accounts ----------
  app.get('/staff', async (req) => {
    await owner(req);
    return many(
      db,
      `SELECT u.id, u.email, u.name, u.role, u.store_id, u.active, u.last_login_at, s.name AS store_name
         FROM staff_users u LEFT JOIN stores s ON s.id = u.store_id ORDER BY u.created_at`,
    );
  });
  app.post('/staff', async (req) => {
    await owner(req);
    const b = z
      .object({
        email: z.string().trim().toLowerCase().email(),
        name: z.string().trim().min(1).max(60),
        role: z.enum(['owner', 'manager', 'staff']),
        storeId: uuid.nullable().default(null),
        password: z.string().min(10, 'Use at least 10 characters').max(200),
      })
      .parse(req.body);
    return one(
      db,
      `INSERT INTO staff_users (email, name, role, store_id, password_hash) VALUES ($1,$2,$3,$4,$5)
       RETURNING id, email, name, role, store_id, active`,
      [b.email, b.name, b.role, b.storeId, await hashPassword(b.password)],
    );
  });
  app.patch('/staff/:id', async (req) => {
    const me = await owner(req);
    const { id } = z.object({ id: uuid }).parse(req.params);
    const b = z
      .object({
        role: z.enum(['owner', 'manager', 'staff']).optional(),
        storeId: uuid.nullable().optional(),
        active: z.boolean().optional(),
        password: z.string().min(10).max(200).optional(),
      })
      .parse(req.body);
    if (id === me.id && (b.active === false || (b.role && b.role !== 'owner'))) {
      throw new HttpError(400, 'You cannot demote or disable your own account');
    }
    await db.query(
      `UPDATE staff_users SET role = coalesce($2, role), store_id = CASE WHEN $3 THEN $4::uuid ELSE store_id END,
              active = coalesce($5, active), password_hash = coalesce($6, password_hash) WHERE id = $1`,
      [id, b.role ?? null, b.storeId !== undefined, b.storeId ?? null, b.active ?? null, b.password ? await hashPassword(b.password) : null],
    );
    return { ok: true };
  });
}
