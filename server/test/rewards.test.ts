// O! Donut's own reward rules: $40 per stamp, a welcome stamp and cream cheese donut on joining,
// and 2 free-donut vouchers for 10 stamps.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { loadConfig } from '../src/config.js';
import { createPool, migrate, type Db } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { seed } from '../src/seed.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/odonut_test';
const CERTS = process.env.TEST_CERT_DIR ?? '/tmp/claude-0/odcerts';

let app: FastifyInstance;
let db: Db;
let cfg: ReturnType<typeof loadConfig>;
const mail: { to: string; subject: string; text: string }[] = [];
let owner = '';

const cookieOf = (res: LightMyRequestResponse, name: string) => `${name}=${res.cookies.find((c) => c.name === name)!.value}`;
const call = (method: string, url: string, o: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  app.inject({ method: method as any, url, payload: o.body as any, headers: { ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.headers ?? {}) } });

async function signUp(email: string, phone: string) {
  await call('POST', '/api/auth/otp', { body: { email } });
  const code = mail.filter((m) => m.to === email).at(-1)!.text.match(/\b(\d{6})\b/)![1];
  let r = await call('POST', '/api/auth/verify', { body: { email, code } });
  r = await call('POST', '/api/auth/signup', {
    cookie: cookieOf(r, 'od_su'),
    body: { firstName: 'Tess', lastName: 'Ter', phone, birthday: '1990-01-15', gender: 'undisclosed', marketingOptIn: true, acceptTerms: true },
  });
  assert.equal(r.statusCode, 200, r.body);
  return cookieOf(r, 'od_c');
}

before(async () => {
  db = createPool(DB_URL);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db, () => {});
  await seed(db, { adminEmail: 'owner@example.com', adminPassword: 'correct horse battery', log: () => {} });
  await db.query('UPDATE program SET stamp_cooldown_seconds = 0');
  cfg = loadConfig({
    APP_SECRET: 'y'.repeat(40),
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
  const r = await call('POST', '/api/staff/login', { body: { email: 'owner@example.com', password: 'correct horse battery' } });
  owner = cookieOf(r, 'od_s');
});

after(async () => {
  await app?.close();
  await db?.end();
});

const stamp = (qr: string, body: Record<string, unknown>) =>
  call('POST', '/api/staff/stamp', { cookie: owner, body: { qrToken: qr, idempotencyKey: crypto.randomUUID(), ...body } });

test('joining gives the first stamp and a free cream cheese donut', async () => {
  const c = await signUp('ruby@example.com', '+852 6100 0001');
  const me = (await call('GET', '/api/me', { cookie: c })).json();
  assert.equal(me.stamps, 1);
  const vouchers = (await call('GET', '/api/me/vouchers', { cookie: c })).json();
  assert.deepEqual(vouchers.map((v: any) => v.title), ['Free Cream Cheese Donut']);
  const welcome = mail.find((m) => m.to === 'ruby@example.com' && /Welcome/.test(m.subject))!;
  assert.match(welcome.text, /1 stamp on your card/);
  assert.match(welcome.text, /1 stamp for every \$40 you spend\. 10 stamps = 2 free donuts\./);

  const config = (await call('GET', '/api/public/config')).json();
  assert.equal(config.spendPerStamp, 40);
  assert.equal(config.signupStamps, 1);
  assert.equal(config.rewardSummary, '2 free donuts');
});

test('stamps are worked out from the bill: $40 each, rounded down', async () => {
  const c = await signUp('sam@example.com', '+852 6100 0002');
  const qr = (await call('GET', '/api/me', { cookie: c })).json().qr_token;

  let r = await stamp(qr, { amount: 39.5 });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /doesn't earn a stamp yet/);

  r = await stamp(qr, { amount: 85 });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().added, 2);
  assert.equal(r.json().stamps, 3);

  r = await stamp(qr, { amount: 80 });
  assert.equal(r.json().added, 2, 'exactly $80 is 2 stamps');

  r = await stamp(qr, { amount: 400 });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /earns 10 stamps, but the limit is 5/);

  const spend = await db.query("SELECT total_spend::float AS t FROM customers WHERE email = 'sam@example.com'");
  assert.equal(spend.rows[0].t, 165);
});

test('10 stamps issue two separate free donut vouchers', async () => {
  const c = await signUp('lee@example.com', '+852 6100 0003');
  const qr = (await call('GET', '/api/me', { cookie: c })).json().qr_token;
  await stamp(qr, { amount: 200 }); // 1 + 5
  const r = await stamp(qr, { amount: 160 }); // + 4 = 10
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().stamps, 0);
  assert.deepEqual(r.json().rewards.map((v: any) => v.title), ['Free Donut', 'Free Donut']);
  assert.notEqual(r.json().rewards[0].code, r.json().rewards[1].code);
});

test('the till can send the order total instead of a stamp count', async () => {
  await signUp('pat@example.com', '+852 6100 0004');
  let r = await call('POST', '/api/admin/api-keys', { cookie: owner, body: { name: 'Till' } });
  const auth = { authorization: `Bearer ${r.json().key}` };
  r = await call('POST', '/api/pos/v1/stamps', { body: { member: { phone: '61000004' }, amount: 120, orderId: 'T1' }, headers: auth });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().stamps, 4);
});

test('the settings page can save the reward rules it was sent', async () => {
  // The settings form sends back the program as it loaded it, then the owner's typing as text.
  const program = (await call('GET', '/api/admin/program', { cookie: owner })).json().program;
  assert.equal(Number(program.spend_per_stamp), 40);
  const r = await call('PATCH', '/api/admin/program', { cookie: owner, body: { spend_per_stamp: '40.00', reward_summary: '2 free classic donuts' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().reward_summary, '2 free classic donuts');
});

test('a shop that counts stamps by hand can switch the bill rule off', async () => {
  await call('PATCH', '/api/admin/program', { cookie: owner, body: { spend_per_stamp: 0, signup_stamps: 0 } });
  const c = await signUp('max@example.com', '+852 6100 0005');
  const qr = (await call('GET', '/api/me', { cookie: c })).json().qr_token;
  assert.equal((await call('GET', '/api/me', { cookie: c })).json().stamps, 0);
  let r = await stamp(qr, { amount: 100 });
  assert.equal(r.statusCode, 400);
  r = await stamp(qr, { count: 2 });
  assert.equal(r.json().stamps, 2);
});
