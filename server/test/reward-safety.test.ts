// Guards against free donuts going to the wrong place: welcome gifts given twice, stamps lost,
// vouchers used twice or after expiry, and counter mistakes that need taking back.
import { test, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { loadConfig } from '../src/config.js';
import { createPool, migrate, type Db } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { seed } from '../src/seed.js';
import { hashPassword } from '../src/lib/crypto.js';
import { runBirthdays } from '../src/services/jobs.js';
import { createCustomer } from '../src/services/loyalty.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/odonut_test';
const CERTS = process.env.TEST_CERT_DIR ?? '/tmp/claude-0/odcerts';

let app: FastifyInstance;
let db: Db;
let cfg: ReturnType<typeof loadConfig>;
const mail: { to: string; subject: string; text: string }[] = [];
let owner = '';
let clerk = '';
let phoneN = 0;

const cookieOf = (res: LightMyRequestResponse, name: string) => `${name}=${res.cookies.find((c) => c.name === name)!.value}`;
const call = (method: string, url: string, o: { cookie?: string; body?: unknown } = {}) =>
  app.inject({ method: method as any, url, payload: o.body as any, headers: o.cookie ? { cookie: o.cookie } : {} });

/** Email code step only: returns the sign-up cookie, so the last step can be raced. */
async function startSignup(email: string) {
  await call('POST', '/api/auth/otp', { body: { email } });
  const code = mail.filter((m) => m.to === email).at(-1)!.text.match(/\b(\d{6})\b/)![1];
  const r = await call('POST', '/api/auth/verify', { body: { email, code } });
  return cookieOf(r, 'od_su');
}
const finishSignup = (su: string, phone: string, extra: Record<string, unknown> = {}) =>
  call('POST', '/api/auth/signup', {
    cookie: su,
    body: { firstName: 'Tess', lastName: 'Ter', phone, birthday: '1990-01-15', gender: 'undisclosed', marketingOptIn: true, acceptTerms: true, ...extra },
  });
async function signUp(email: string, extra: Record<string, unknown> = {}) {
  const r = await finishSignup(await startSignup(email), `+852 6200 ${String(++phoneN).padStart(4, '0')}`, extra);
  assert.equal(r.statusCode, 200, r.body);
  const cookie = cookieOf(r, 'od_c');
  const me = (await call('GET', '/api/me', { cookie })).json();
  return { cookie, qr: me.qr_token as string, id: me.id as string };
}

const stamp = (qr: string, body: Record<string, unknown>, cookie = owner) =>
  call('POST', '/api/staff/stamp', { cookie, body: { qrToken: qr, idempotencyKey: crypto.randomUUID(), ...body } });
const vouchers = async (cookie: string) => (await call('GET', '/api/me/vouchers', { cookie })).json() as any[];

before(async () => {
  db = createPool(DB_URL);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db, () => {});
  await seed(db, { adminEmail: 'owner@example.com', adminPassword: 'correct horse battery', log: () => {} });
  await db.query('UPDATE program SET verify_phone_at_signup = false, stamp_cooldown_seconds = 0');
  await db.query(`INSERT INTO staff_users (email, name, role, password_hash) VALUES ('clerk@example.com', 'Clerk', 'staff', $1)`, [
    await hashPassword('another horse battery'),
  ]);
  cfg = loadConfig({
    APP_SECRET: 'z'.repeat(40),
    PUBLIC_URL: 'https://loyalty.example.com',
    DATABASE_URL: DB_URL,
    APPLE_PASS_TYPE_ID: 'pass.test.odonut',
    APPLE_TEAM_ID: 'TESTTEAM01',
    APPLE_PASS_CERT_FILE: join(CERTS, 'signer.pem'),
    APPLE_PASS_KEY_FILE: join(CERTS, 'signer.key'),
    APPLE_WWDR_FILE: join(CERTS, 'wwdr.pem'),
    WEB_DIST: '/nonexistent',
  } as any);
  app = await buildApp(cfg, db, {
    logger: false,
    mailer: { send: async (to, subject, text) => void mail.push({ to, subject, text }) },
  });
  app.svc.notifier.apns!.send = async (tokens: string[]) => tokens.map((token) => ({ token, status: 200 }));
  let r = await call('POST', '/api/staff/login', { body: { email: 'owner@example.com', password: 'correct horse battery' } });
  owner = cookieOf(r, 'od_s');
  r = await call('POST', '/api/staff/login', { body: { email: 'clerk@example.com', password: 'another horse battery' } });
  clerk = cookieOf(r, 'od_s');
});

after(async () => {
  await app?.close();
  await db?.end();
});

test('two sign-ups racing for the same inbox get only one welcome gift', async () => {
  // Gmail ignores dots, so these reach the same person. The first sign-up is still in progress
  // (not committed) when the second one runs: the second must not see "not claimed yet".
  const input = (email: string, phone: string) => ({ email, firstName: 'Dot', lastName: 'Ty', phone, marketingOptIn: false });
  const first = await db.connect();
  const second = await db.connect();
  try {
    await first.query('BEGIN');
    await second.query('BEGIN');
    const a = await createCustomer(first, input('dot.ty@gmail.com', '+85263000001'));
    const pending = createCustomer(second, input('dotty@gmail.com', '+85263000002'));
    await new Promise((res) => setTimeout(res, 100));
    await first.query('COMMIT');
    const b = await pending;
    await second.query('COMMIT');
    assert.equal(a.welcomeClaimed, false);
    assert.equal(b.welcomeClaimed, true, 'the second sign-up gets no welcome gift');
    assert.equal(b.vouchers.length, 0);
    assert.equal(b.card.stamps, 0);
  } finally {
    first.release();
    second.release();
  }
});

test('moving an account to a new mobile number uses up that number\'s welcome gift', async () => {
  const m = await signUp('mover@example.com');
  let r = await call('PATCH', '/api/me', { cookie: m.cookie, body: { phone: '+852 6300 0099' } });
  assert.equal(r.statusCode, 200, r.body);
  await call('DELETE', '/api/me', { cookie: m.cookie });
  r = await finishSignup(await startSignup('mover2@example.com'), '+852 6300 0099');
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().welcomeAlreadyClaimed, true);
});

test('a full card keeps its stamps while the reward voucher is switched off', async () => {
  const m = await signUp('patient@example.com');
  const tpl = (await db.query('SELECT reward_template_id AS id FROM program')).rows[0].id;
  await db.query('UPDATE voucher_templates SET active = false WHERE id = $1', [tpl]);
  try {
    await stamp(m.qr, { amount: 200 });
    const r = await stamp(m.qr, { amount: 160 });
    assert.equal(r.json().stamps, 10, 'stamps are not thrown away');
    assert.equal(r.json().rewards.length, 0);
  } finally {
    await db.query('UPDATE voucher_templates SET active = true WHERE id = $1', [tpl]);
  }
  const r = await stamp(m.qr, { count: 1 });
  assert.equal(r.json().stamps, 1);
  assert.deepEqual(r.json().rewards.map((v: any) => v.title), ['2 Free Donuts']);
});

test('an order number reused on another member\'s card is refused, not skipped', async () => {
  const a = await signUp('ord1@example.com');
  const b = await signUp('ord2@example.com');
  const key = crypto.randomUUID();
  assert.equal((await stamp(a.qr, { count: 1, idempotencyKey: key })).statusCode, 200);
  const r = await stamp(b.qr, { count: 1, idempotencyKey: key });
  assert.equal(r.statusCode, 409);
});

test('vouchers: one use only, and an expired one is refused and marked expired', async () => {
  const m = await signUp('vee@example.com');
  const [welcome] = await vouchers(m.cookie);
  let r = await call('POST', '/api/staff/redeem', { cookie: owner, body: { code: welcome.code } });
  assert.equal(r.statusCode, 200, r.body);
  // Double tap / second scan of the same voucher.
  r = await call('POST', '/api/staff/redeem', { cookie: owner, body: { code: welcome.code } });
  assert.equal(r.statusCode, 409);
  assert.match(r.json().error, /already used just now/);

  const tpl = (await db.query('SELECT welcome_template_id AS id FROM program')).rows[0].id;
  const v = (await db.query(
    `INSERT INTO vouchers (customer_id, template_id, code, source, expires_at) VALUES ($1, $2, 'VOLDONE01', 'manual', now() - interval '1 minute') RETURNING id`,
    [m.id, tpl],
  )).rows[0];
  r = await call('POST', '/api/staff/redeem', { cookie: owner, body: { code: 'voldone01' } });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, 'expired');
  const status = (await db.query('SELECT status FROM vouchers WHERE id = $1', [v.id])).rows[0].status;
  assert.equal(status, 'expired', 'the expiry is saved, not rolled back');
});

test('two tills redeeming the same voucher at once: only one succeeds', async () => {
  const m = await signUp('race@example.com');
  const [welcome] = await vouchers(m.cookie);
  const rs = await Promise.all([owner, clerk].map((cookie) => call('POST', '/api/staff/redeem', { cookie, body: { code: welcome.code } })));
  assert.deepEqual(rs.map((r) => r.statusCode).sort(), [200, 409]);
});

test('undo a stamp added by mistake: stamps, visit and spend all go back', async () => {
  const m = await signUp('oops@example.com');
  const r = await stamp(m.qr, { amount: 120 }, clerk);
  assert.equal(r.json().stamps, 4);
  let u = await call('POST', '/api/staff/stamp/undo', { cookie: clerk, body: { eventId: r.json().eventId } });
  assert.equal(u.statusCode, 200, u.body);
  assert.equal(u.json().stamps, 1);
  assert.equal(u.json().removed, 3);
  const c = (await db.query('SELECT visit_count, total_spend::float AS spend, last_visit_at FROM customers WHERE id = $1', [m.id])).rows[0];
  assert.deepEqual([c.visit_count, c.spend, c.last_visit_at], [0, 0, null]);
  // A second tap on Undo does nothing.
  u = await call('POST', '/api/staff/stamp/undo', { cookie: clerk, body: { eventId: r.json().eventId } });
  assert.equal(u.statusCode, 404);
});

test('undoing the stamp that completed a card cancels the reward it gave', async () => {
  await db.query('UPDATE program SET stamp_multiplier = 2, multiplier_starts_at = NULL, multiplier_ends_at = NULL');
  try {
    const m = await signUp('fill@example.com');
    await stamp(m.qr, { count: 4 }); // 1 + 4×2 = 9
    const r = await stamp(m.qr, { count: 1 }); // + 1×2 = 11 -> reward, 1 left
    assert.equal(r.json().stamps, 1);
    assert.equal(r.json().rewards.length, 1);
    const u = await call('POST', '/api/staff/stamp/undo', { cookie: owner, body: { eventId: r.json().eventId } });
    assert.equal(u.statusCode, 200, u.body);
    assert.equal(u.json().stamps, 9);
    assert.equal(u.json().vouchersVoided, 1);
    assert.ok(!(await vouchers(m.cookie)).some((v) => v.source === 'stamp_reward' && v.status === 'active'));
    const card = (await db.query('SELECT rewards_earned, lifetime_stamps FROM cards WHERE customer_id = $1', [m.id])).rows[0];
    assert.deepEqual([card.rewards_earned, card.lifetime_stamps], [0, 9]);
  } finally {
    await db.query('UPDATE program SET stamp_multiplier = 1');
  }
});

test('undo is refused once the reward was used, after another stamp, or by someone else', async () => {
  const m = await signUp('late@example.com');
  await stamp(m.qr, { count: 5 });
  const r = await stamp(m.qr, { count: 4 }, clerk);
  const reward = r.json().rewards[0];
  assert.ok(reward);
  await call('POST', '/api/staff/redeem', { cookie: owner, body: { code: reward.code } });
  let u = await call('POST', '/api/staff/stamp/undo', { cookie: clerk, body: { eventId: r.json().eventId } });
  assert.equal(u.statusCode, 409);
  assert.equal(u.json().code, 'reward_used');

  const first = await stamp(m.qr, { count: 1 }, owner);
  await stamp(m.qr, { count: 1 }, owner);
  u = await call('POST', '/api/staff/stamp/undo', { cookie: owner, body: { eventId: first.json().eventId } });
  assert.equal(u.json().code, 'stamped_since');

  const last = await stamp(m.qr, { count: 1 }, owner);
  u = await call('POST', '/api/staff/stamp/undo', { cookie: clerk, body: { eventId: last.json().eventId } });
  assert.equal(u.statusCode, 403, 'counter staff can only undo their own');

  await db.query(`UPDATE stamp_events SET created_at = created_at - interval '11 minutes' WHERE id = $1`, [last.json().eventId]);
  u = await call('POST', '/api/staff/stamp/undo', { cookie: owner, body: { eventId: last.json().eventId } });
  assert.equal(u.json().code, 'too_late');
});

test('undoing a friend\'s first visit also takes back the referral thank-you', async () => {
  const alice = await signUp('ref-a@example.com');
  const code = (await call('GET', '/api/me', { cookie: alice.cookie })).json().referral_code;
  const bob = await signUp('ref-b@example.com', { referralCode: code });
  const r = await stamp(bob.qr, { count: 1 });
  assert.ok((await vouchers(alice.cookie)).some((v) => v.source === 'referral' && v.status === 'active'));
  const u = await call('POST', '/api/staff/stamp/undo', { cookie: owner, body: { eventId: r.json().eventId } });
  assert.equal(u.statusCode, 200, u.body);
  assert.ok(!(await vouchers(alice.cookie)).some((v) => v.source === 'referral' && v.status === 'active'));
});

test('a voucher redeemed by mistake can be put back for a few minutes', async () => {
  const m = await signUp('putback@example.com');
  const [welcome] = await vouchers(m.cookie);
  await call('POST', '/api/staff/redeem', { cookie: clerk, body: { code: welcome.code } });
  let u = await call('POST', '/api/staff/redeem/undo', { cookie: clerk, body: { code: welcome.code } });
  assert.equal(u.statusCode, 200, u.body);
  assert.equal((await vouchers(m.cookie))[0].status, 'active');
  // ...and then used for real, once.
  assert.equal((await call('POST', '/api/staff/redeem', { cookie: clerk, body: { code: welcome.code } })).statusCode, 200);
  await db.query(`UPDATE vouchers SET redeemed_at = now() - interval '11 minutes' WHERE code = $1`, [welcome.code]);
  u = await call('POST', '/api/staff/redeem/undo', { cookie: clerk, body: { code: welcome.code } });
  assert.equal(u.json().code, 'too_late');
  u = await call('POST', '/api/staff/redeem/undo', { cookie: clerk, body: { code: 'VNOTAREALCODE' } });
  assert.equal(u.statusCode, 404);
});

test('29 February birthdays get their treat on 28 February in other years', async () => {
  const m = await signUp('leap@example.com', { birthday: '2000-02-29' });
  // 10:00 on 28 Feb 2027 in Hong Kong.
  mock.timers.enable({ apis: ['Date'], now: Date.parse('2027-02-28T02:00:00Z') });
  try {
    await runBirthdays(db, cfg, app.svc.notifier, () => {});
  } finally {
    mock.timers.reset();
  }
  assert.ok((await vouchers(m.cookie)).some((v) => v.source === 'birthday'));
});

test('no second cream cheese donut from a promo code: HELLODONUT is gone, and welcome-gift codes skip members who had it', async () => {
  const m = await signUp('promo@example.com');
  let r = await call('POST', '/api/me/promo', { cookie: m.cookie, body: { code: 'HELLODONUT' } });
  assert.equal(r.statusCode, 404);
  // Even if the owner makes a new code for the welcome donut, a member who already got it can't get it again.
  await db.query(`INSERT INTO promo_codes (code, template_id) SELECT 'WELCOMEAGAIN', welcome_template_id FROM program`);
  r = await call('POST', '/api/me/promo', { cookie: m.cookie, body: { code: 'WELCOMEAGAIN' } });
  assert.equal(r.statusCode, 409);
  assert.equal((await vouchers(m.cookie)).filter((v) => v.title === 'Free Cream Cheese Donut').length, 1);
});
