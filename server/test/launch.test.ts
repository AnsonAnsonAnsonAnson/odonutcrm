// Launch tools: double-stamp promotions, the Apple certificate check, and the go-live doctor.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { loadConfig } from '../src/config.js';
import { createPool, migrate, type Db } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { seed } from '../src/seed.js';
import { checkAppleCert } from '../src/lib/certs.js';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

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
  // These tests use the classic one-stamp-per-visit rules; rewards.test.ts covers the shop's own rules.
  await db.query('UPDATE program SET signup_stamps = 0, reward_voucher_count = 1');
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


test('a double-stamps window multiplies purchase stamps only while it is open', async () => {
  const kim = await signUp('kim@example.com', '+852 6000 1111');
  const qr = (await call('GET', '/api/me', { cookie: kim })).json().qr_token;
  const stamp = (count: number) => call('POST', '/api/staff/stamp', { cookie: owner, body: { qrToken: qr, count, idempotencyKey: crypto.randomUUID() } }).then((r) => r.json());

  // Scheduled for tomorrow: not active yet.
  const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
  let r = await call('PATCH', '/api/admin/program', { cookie: owner, body: { stamp_multiplier: 2, multiplier_starts_at: tomorrow, multiplier_ends_at: null, multiplier_label: 'Launch double stamps' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await call('GET', '/api/public/config')).json().stampPromo, null);
  assert.equal((await stamp(1)).stamps, 1);

  // Open now, ends in two weeks.
  const ends = new Date(Date.now() + 14 * 86_400_000).toISOString();
  await call('PATCH', '/api/admin/program', { cookie: owner, body: { multiplier_starts_at: null, multiplier_ends_at: ends } });
  const promo = (await call('GET', '/api/public/config')).json().stampPromo;
  assert.deepEqual(promo, { multiplier: 2, label: 'Launch double stamps', endsAt: ends });
  assert.equal((await call('GET', '/api/staff/me', { cookie: owner })).json().promo.multiplier, 2);
  let s = await stamp(3);
  assert.equal(s.bonus, 3);
  assert.equal(s.stamps, 7);
  // 7 + 2x2 = 11 -> card completes, 1 left over.
  s = await stamp(2);
  assert.equal(s.rewards.length, 1);
  assert.equal(s.stamps, 1);
  const hist = (await call('GET', '/api/me/history', { cookie: kim })).json();
  assert.ok(hist.some((h: any) => h.type === 'stamp' && h.delta === 3), 'bonus row in the ledger');

  // Manual adjustments are never multiplied.
  const me = (await call('GET', '/api/me', { cookie: kim })).json();
  const customerId = (await db.query('SELECT customer_id FROM cards WHERE qr_token = $1', [qr])).rows[0].customer_id;
  r = await call('POST', `/api/admin/customers/${customerId}/stamps`, { cookie: owner, body: { delta: 2, note: 'goodwill' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await call('GET', '/api/me', { cookie: kim })).json().stamps, me.stamps + 2);

  // Window over.
  await call('PATCH', '/api/admin/program', { cookie: owner, body: { multiplier_ends_at: new Date(Date.now() - 1000).toISOString() } });
  assert.equal((await stamp(1)).bonus, 0);
});

test('the Apple certificate check catches a wrong key, team, CA and an expiring certificate', () => {
  const apple = cfg.apple!;
  const good = checkAppleCert(apple);
  assert.ok(good.expiresAt);
  // The test certificate lasts 30 days, so it is flagged as expiring soon and nothing else.
  assert.deepEqual(good.problems.filter((p) => !p.includes('expires in')), []);
  assert.ok(checkAppleCert(apple, new Date(Date.now() + 40 * 86_400_000)).problems.some((p) => p.includes('has expired')));
  const otherKey = readFileSync(`${CERTS}/wwdr.key`);
  assert.ok(checkAppleCert({ ...apple, key: otherKey }).problems.some((p) => p.includes('does not belong')));
  assert.ok(checkAppleCert({ ...apple, teamId: 'OTHERTEAM1' }).problems.some((p) => p.includes('belongs to team')));
  assert.ok(checkAppleCert({ ...apple, wwdr: apple.cert }).problems.some((p) => p.includes('not the Apple intermediate')));
  return call('GET', '/api/admin/program', { cookie: owner }).then((r) => {
    assert.equal(r.json().integrations.appleCert.expiresAt, good.expiresAt);
  });
});

test('the go-live doctor reports what is missing and exits non-zero in production', () => {
  let out = '';
  let code = 0;
  try {
    out = execFileSync('node', ['--import', 'tsx', 'src/cli/doctor.ts'], {
      env: { PATH: process.env.PATH, NODE_ENV: 'production', APP_SECRET: 'z'.repeat(40), PUBLIC_URL: 'https://loyalty.example.com', DATABASE_URL: DB_URL },
      encoding: 'utf8',
    });
  } catch (e: any) {
    out = e.stdout;
    code = e.status;
  }
  assert.equal(code, 1);
  assert.match(out, /✓ Database\s+connected, \d+ migrations applied/);
  assert.match(out, /✗ Apple Wallet\s+not set up/);
  assert.match(out, /✗ Email\s+SMTP is not set/);
  assert.match(out, /problem\(s\) to fix before launch/);
});

test('the app starts before the wallet certificates exist (paths from .env.example, IDs blank)', () => {
  const c = loadConfig({
    APP_SECRET: 'q'.repeat(40),
    PUBLIC_URL: 'https://loyalty.example.com',
    DATABASE_URL: DB_URL,
    APPLE_PASS_CERT_FILE: '/secrets/pass-cert.pem',
    APPLE_PASS_KEY_FILE: '/secrets/pass-key.pem',
    APPLE_WWDR_FILE: '/secrets/wwdr.pem',
    GOOGLE_SERVICE_ACCOUNT_FILE: '/secrets/google-wallet-sa.json',
  } as any);
  assert.equal(c.apple, null);
  assert.equal(c.google, null);
  // Once the IDs are filled in, a missing file is a clear error rather than a silent skip.
  assert.throws(
    () => loadConfig({ APP_SECRET: 'q'.repeat(40), PUBLIC_URL: 'https://x.hk', DATABASE_URL: DB_URL, APPLE_PASS_TYPE_ID: 'pass.x', APPLE_TEAM_ID: 'T', APPLE_PASS_CERT_FILE: '/secrets/pass-cert.pem' } as any),
    /Configured file not found: \/secrets\/pass-cert.pem/,
  );
});

test('the admin email check says plainly what is wrong', async () => {
  const r = await call('POST', '/api/admin/test-email', { cookie: owner, body: {} });
  assert.equal(r.statusCode, 409);
  assert.match(r.json().error, /no SMTP_HOST setting/);
  const { explainMailError } = await import('../src/lib/mailer.js');
  assert.match(explainMailError({ code: 'EAUTH', response: '535 5.7.8 Username and Password not accepted' }), /app password.*535/s);
  assert.match(explainMailError({ code: 'ETIMEDOUT', message: 'Connection timeout' }), /smtp\.gmail\.com and 587/);
});

test('the email sender setting tolerates how people type it into a dashboard', async () => {
  const { senderAddress } = await import('../src/config.js');
  assert.equal(senderAddress('O! Donut &lt;shop@gmail.com&gt;', undefined), 'O! Donut <shop@gmail.com>');
  assert.equal(senderAddress('shop@gmail.com', undefined), 'O! Donut <shop@gmail.com>');
  assert.equal(senderAddress(undefined, 'shop@gmail.com'), 'O! Donut <shop@gmail.com>');
  const c = loadConfig({ APP_SECRET: 'z'.repeat(40), DATABASE_URL: 'postgres://x/y', SMTP_HOST: 'smtp.gmail.com', SMTP_USER: 'shop@gmail.com', SMTP_PASS: 'abcd efgh ijkl mnop' } as any);
  assert.equal(c.smtp?.pass, 'abcdefghijklmnop');
  assert.equal(c.smtp?.from, 'O! Donut <shop@gmail.com>');
});
