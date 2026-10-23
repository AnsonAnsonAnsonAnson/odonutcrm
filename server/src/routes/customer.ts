import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { one, many, withTx } from '../db.js';
import { HttpError, CUSTOMER_COOKIE } from '../lib/auth.js';
import { explainMailError } from '../lib/mailer.js';
import { hmac, otpCode, safeEqual } from '../lib/crypto.js';
import { applyPromoCode, createCustomer, customerHistory, customerVouchers } from '../services/loyalty.js';
import { activeMultiplier, getProgram } from '../services/program.js';
import { memberCenterUrl } from '../services/apple/pass.js';
import { tierProgress } from '../services/tiers.js';

const SIGNUP_COOKIE = 'od_su';
const email = z.string().trim().toLowerCase().email().max(200);

export async function customerRoutes(app: FastifyInstance) {
  const { db, cfg, sessions, mailer, sms, notifier, log } = app.svc;

  async function requireCustomer(req: FastifyRequest): Promise<string> {
    const s = await sessions.customer(req);
    if (!s) throw new HttpError(401, 'Please sign in');
    const exists = await one(db, 'SELECT 1 FROM customers WHERE id = $1', [s.id]);
    if (!exists) throw new HttpError(401, 'Please sign in');
    return s.id;
  }

  app.get('/public/config', async () => {
    const p = await getProgram(db);
    return {
      brandName: p.brand_name,
      programName: p.name,
      stampsRequired: p.stamps_required,
      backgroundColor: p.background_color,
      foregroundColor: p.foreground_color,
      labelColor: p.label_color,
      terms: p.terms,
      privacyPolicy: p.privacy_policy,
      smsSignIn: sms.enabled,
      appleWallet: !!cfg.apple,
      googleWallet: !!cfg.google,
      vapidPublicKey: cfg.vapid?.publicKey ?? null,
      stampPromo: activeMultiplier(p),
    };
  });

  // ---- Email one-time-code sign in / register (same flow as the Wanpo/Juicysuite member site) ----

  // Email codes work for everyone; SMS codes are for existing members (prevents SMS-pumping abuse).
  const phone = z.string().trim().transform((v) => v.replace(/[\s-]/g, '')).pipe(z.string().regex(/^\+\d{8,15}$/, 'Enter your mobile number with country code'));

  app.post(
    '/auth/otp',
    { config: { rateLimit: { max: 5, timeWindow: '10 minutes' } } },
    async (req) => {
      const body = z
        .object({ email: email.optional(), phone: phone.optional(), locale: z.enum(['en', 'zh-HK']).optional() })
        .refine((b) => !!b.email !== !!b.phone, 'Enter an email or a mobile number')
        .parse(req.body);
      const channel = body.email ? 'email' : 'sms';
      const identity = body.email ?? `sms:${body.phone}`;
      if (channel === 'sms') {
        if (!sms.enabled) throw new HttpError(400, 'Sign-in by SMS is not available. Please use your email.');
        const member = await one(db, 'SELECT 1 FROM customers WHERE phone = $1', [body.phone]);
        if (!member) throw new HttpError(404, 'No member uses that number yet. Sign up with your email first.', 'no_member');
        const today = await one<{ n: number }>(
          db,
          `SELECT count(*)::int AS n FROM otp_codes WHERE identity = $1 AND created_at > now() - interval '1 day'`,
          [identity],
        );
        if ((today?.n ?? 0) >= 5) throw new HttpError(429, 'Too many codes today. Please sign in with your email.');
      }
      // A daily cap per address too, so nobody can flood a member's inbox from many IPs.
      const daily = await one<{ n: number }>(
        db,
        `SELECT count(*)::int AS n FROM otp_codes WHERE identity = $1 AND created_at > now() - interval '1 day'`,
        [identity],
      );
      if (channel === 'email' && (daily?.n ?? 0) >= 10) {
        throw new HttpError(429, 'Too many codes for this email today. Please try again tomorrow, or ask the shop for help.');
      }
      const recent = await one(
        db,
        `SELECT 1 FROM otp_codes WHERE identity = $1 AND created_at > now() - interval '45 seconds'`,
        [identity],
      );
      if (recent) throw new HttpError(429, 'Please wait a moment before requesting another code');
      const code = otpCode();
      await db.query(
        `INSERT INTO otp_codes (identity, channel, code_hash, expires_at) VALUES ($1, $2, $3, now() + interval '10 minutes')`,
        [identity, channel, hmac(cfg.secret, `${identity}:${code}`)],
      );
      const p = await getProgram(db);
      const zh = body.locale === 'zh-HK';
      if (channel === 'sms') {
        await sms.send(body.phone!, zh ? `${p.brand_name} 驗證碼：${code}（10 分鐘內有效）` : `${p.brand_name} code: ${code} (valid 10 minutes)`);
      } else {
        try {
          await mailer.send(
            body.email!,
            zh ? `${p.brand_name} 驗證碼：${code}` : `Your ${p.brand_name} code: ${code}`,
            zh
              ? `你的驗證碼是 ${code}，10 分鐘內有效。如非本人操作，請忽略此電郵。`
              : `Your verification code is ${code}. It expires in 10 minutes. If you didn't ask for it, you can ignore this email.`,
          );
        } catch (err) {
          log(`sign-in code email failed: ${explainMailError(err)}`);
          // The code never arrived, so don't make the member wait out the resend delay.
          await db.query(`DELETE FROM otp_codes WHERE identity = $1 AND created_at > now() - interval '1 minute'`, [identity]);
          throw new HttpError(503, "We couldn't send the email just now. Please try again in a minute, or ask the shop for help.");
        }
      }
      return { ok: true, channel };
    },
  );

  app.post(
    '/auth/verify',
    { config: { rateLimit: { max: 20, timeWindow: '10 minutes' } } },
    async (req, reply) => {
      const body = z
        .object({ email: email.optional(), phone: phone.optional(), code: z.string().trim().regex(/^\d{6}$/) })
        .refine((b) => !!b.email !== !!b.phone, 'Enter an email or a mobile number')
        .parse(req.body);
      const identity = body.email ?? `sms:${body.phone}`;
      const otp = await one<{ id: string; code_hash: string; attempts: number }>(
        db,
        `SELECT id, code_hash, attempts FROM otp_codes
          WHERE identity = $1 AND consumed_at IS NULL AND expires_at > now()
          ORDER BY created_at DESC LIMIT 1`,
        [identity],
      );
      if (!otp || otp.attempts >= 5) throw new HttpError(400, 'That code has expired. Please request a new one.', 'expired');
      if (!safeEqual(otp.code_hash, hmac(cfg.secret, `${identity}:${body.code}`))) {
        await db.query('UPDATE otp_codes SET attempts = attempts + 1 WHERE id = $1', [otp.id]);
        throw new HttpError(400, 'That code is not right. Please try again.', 'invalid');
      }
      await db.query('UPDATE otp_codes SET consumed_at = now() WHERE id = $1', [otp.id]);
      const customer = body.email
        ? await one<{ id: string }>(db, 'SELECT id FROM customers WHERE email = $1', [body.email])
        : await one<{ id: string }>(db, 'SELECT id FROM customers WHERE phone = $1 ORDER BY last_visit_at DESC NULLS LAST LIMIT 1', [body.phone]);
      if (customer) {
        await sessions.setCustomer(reply, customer.id);
        return { status: 'ok' };
      }
      if (!body.email) throw new HttpError(404, 'No member uses that number yet. Sign up with your email first.');
      const token = await sessions.sign({ email: body.email }, 'signup', '30m');
      reply.setCookie(SIGNUP_COOKIE, token, sessions.cookieOptions(30 * 60));
      return { status: 'signup', email: body.email };
    },
  );

  app.post('/auth/signup', async (req, reply) => {
    const pending = await sessions.verify<{ email: string }>(req.cookies[SIGNUP_COOKIE], 'signup');
    if (!pending) throw new HttpError(401, 'Your sign-up session expired. Please enter your email again.');
    const body = z
      .object({
        firstName: z.string().trim().min(1).max(60),
        lastName: z.string().trim().min(1).max(60),
        phone: z.string().trim().regex(/^\+?[0-9 ]{6,20}$/, 'Enter a valid mobile number'),
        birthday: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((d) => !isNaN(Date.parse(d)) && Date.parse(d) < Date.now(), 'Enter a valid date'),
        gender: z.enum(['male', 'female', 'other', 'undisclosed']),
        marketingOptIn: z.boolean().default(false),
        acceptTerms: z.literal(true, { message: 'Please accept the terms' }),
        referralCode: z.string().trim().max(20).optional().nullable(),
        locale: z.enum(['en', 'zh-HK']).default('en'),
      })
      .parse(req.body);

    const result = await withTx(db, async (tx) => {
      const existing = await one<{ id: string }>(tx, 'SELECT id FROM customers WHERE email = $1', [pending.email]);
      if (existing) return { id: existing.id, vouchers: [] };
      const r = await createCustomer(tx, {
        email: pending.email,
        firstName: body.firstName,
        lastName: body.lastName,
        phone: body.phone.replace(/\s/g, ''),
        birthday: body.birthday,
        gender: body.gender,
        locale: body.locale,
        marketingOptIn: body.marketingOptIn,
        referralCode: body.referralCode,
      });
      return { id: r.customer.id, vouchers: r.vouchers, card: r.card, created: true };
    });
    const program = await getProgram(db);
    if ('created' in result && program.welcome_email_enabled) {
      const link = memberCenterUrl(cfg.publicUrl, { card: result.card } as any);
      const zh = body.locale === 'zh-HK';
      const gifts = result.vouchers.map((v) => v.title).join(', ');
      // Awaited: on serverless hosts, work left running after the response can be cut off.
      await mailer
        .send(
          pending.email,
          zh ? `歡迎加入 ${program.brand_name}！` : `Welcome to ${program.brand_name}!`,
          zh
            ? `${body.firstName} 你好，

多謝加入！${gifts ? `你的迎新禮「${gifts}」已存入會員中心。` : ''}

開啟會員卡並加入手機錢包：
${link}

每次光臨出示會員卡即可收集印花，集滿 ${program.stamps_required} 個即可換領獎賞。`
            : `Hi ${body.firstName},

Thanks for joining!${gifts ? ` Your welcome gift (${gifts}) is waiting in your Member Center.` : ''}

Open your card and add it to your phone's wallet:
${link}

Show your card every visit to collect a stamp. Collect ${program.stamps_required} to earn a reward.`,
        )
        .catch((err) => log(`welcome email failed: ${explainMailError(err)}`));
    }
    reply.clearCookie(SIGNUP_COOKIE, { path: '/' });
    await sessions.setCustomer(reply, result.id);
    return { status: 'ok', welcomeVouchers: result.vouchers.map((v) => ({ title: v.title, expiresAt: v.expires_at })) };
  });

  app.post('/auth/logout', async (_req, reply) => {
    reply.clearCookie(CUSTOMER_COOKIE, { path: '/' });
    return { ok: true };
  });

  // "Member Center" link on the back of the wallet pass.
  app.get('/auth/card-login', async (req, reply) => {
    const q = z.object({ s: z.string().max(64), t: z.string().max(128) }).parse(req.query);
    const card = await one<{ customer_id: string; auth_token: string }>(db, 'SELECT customer_id, auth_token FROM cards WHERE serial_number = $1', [q.s]);
    if (!card || !safeEqual(card.auth_token, q.t)) return reply.redirect('/');
    await sessions.setCustomer(reply, card.customer_id);
    return reply.redirect('/me');
  });

  // Desktop sign-up shows a QR of this link so the phone opens the card already signed in.
  app.get('/auth/handoff', async (req, reply) => {
    const q = z.object({ t: z.string().max(1000) }).parse(req.query);
    const id = await sessions.verifyHandoff(q.t);
    if (!id) return reply.redirect('/');
    await sessions.setCustomer(reply, id);
    return reply.redirect('/me/wallet');
  });

  // ---- Member center ----

  app.get('/me', async (req) => {
    const id = await requireCustomer(req);
    const p = await getProgram(db);
    const me = await one(
      db,
      `SELECT c.id, c.email, c.first_name, c.last_name, c.phone, c.birthday, c.gender, c.locale, c.marketing_opt_in,
              c.referral_code, c.created_at, c.visit_count,
              k.stamps, k.lifetime_stamps, k.rewards_earned, k.qr_token, k.serial_number, k.google_saved, k.updated_at AS card_updated_at,
              EXISTS (SELECT 1 FROM apple_registrations r WHERE r.serial_number = k.serial_number) AS apple_saved,
              EXISTS (SELECT 1 FROM web_push_subscriptions w WHERE w.customer_id = c.id) AS web_push,
              (SELECT count(*)::int FROM vouchers v WHERE v.customer_id = c.id AND v.status = 'active' AND v.expires_at > now()) AS active_vouchers
         FROM customers c JOIN cards k ON k.customer_id = c.id WHERE c.id = $1`,
      [id],
    );
    const tier = p.tiers_enabled ? await tierProgress(db, id, p.tier_window_days) : null;
    return { ...me, stamps_required: p.stamps_required, tier };
  });

  app.patch('/me', async (req) => {
    const id = await requireCustomer(req);
    const b = z
      .object({
        firstName: z.string().trim().min(1).max(60).optional(),
        lastName: z.string().trim().min(1).max(60).optional(),
        phone: z.string().trim().regex(/^\+?[0-9 ]{6,20}$/).optional(),
        marketingOptIn: z.boolean().optional(),
        locale: z.enum(['en', 'zh-HK']).optional(),
      })
      .parse(req.body);
    await db.query(
      `UPDATE customers SET first_name = coalesce($2, first_name), last_name = coalesce($3, last_name),
              phone = coalesce($4, phone), marketing_opt_in = coalesce($5, marketing_opt_in), locale = coalesce($6, locale)
        WHERE id = $1`,
      [id, b.firstName ?? null, b.lastName ?? null, b.phone?.replace(/\s/g, '') ?? null, b.marketingOptIn ?? null, b.locale ?? null],
    );
    if (b.firstName || b.lastName) {
      await db.query('UPDATE cards SET updated_at = now() WHERE customer_id = $1', [id]);
      void notifier.passChanged(id);
    }
    return { ok: true };
  });

  // Personal data deletion (Hong Kong PDPO / GDPR style request).
  app.delete('/me', async (req, reply) => {
    const id = await requireCustomer(req);
    await db.query('DELETE FROM customers WHERE id = $1', [id]);
    reply.clearCookie(CUSTOMER_COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/me/vouchers', async (req) => customerVouchers(db, await requireCustomer(req)));
  app.get('/me/history', async (req) => customerHistory(db, await requireCustomer(req)));
  app.get('/me/notifications', async (req) =>
    many(db, 'SELECT title, body, created_at FROM notifications WHERE customer_id = $1 ORDER BY created_at DESC LIMIT 30', [
      await requireCustomer(req),
    ]),
  );

  app.post(
    '/me/promo',
    { config: { rateLimit: { max: 10, timeWindow: '10 minutes' } } },
    async (req) => {
      const id = await requireCustomer(req);
      const { code } = z.object({ code: z.string().trim().min(2).max(40) }).parse(req.body);
      const v = await applyPromoCode(db, id, code);
      void notifier.passChanged(id);
      return { title: v.title, expiresAt: v.expires_at };
    },
  );

  app.get('/me/handoff', async (req) => {
    const id = await requireCustomer(req);
    const t = await sessions.handoffToken(id);
    return { url: `${cfg.publicUrl}/api/auth/handoff?t=${encodeURIComponent(t)}` };
  });

  app.post('/me/push-subscription', async (req) => {
    const id = await requireCustomer(req);
    const b = z
      .object({ endpoint: z.string().url().max(1000), keys: z.object({ p256dh: z.string().max(200), auth: z.string().max(100) }) })
      .parse(req.body);
    await db.query(
      `INSERT INTO web_push_subscriptions (customer_id, endpoint, p256dh, auth) VALUES ($1,$2,$3,$4)
       ON CONFLICT (endpoint) DO UPDATE SET customer_id = $1, p256dh = $3, auth = $4`,
      [id, b.endpoint, b.keys.p256dh, b.keys.auth],
    );
    return { ok: true };
  });
}
