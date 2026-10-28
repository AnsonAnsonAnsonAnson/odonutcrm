// Launch performance pass: dashboard in shop time, search, sign-in code guessing, caching and indexes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { loadConfig } from '../src/config.js';
import { createPool, migrate, type Db } from '../src/db.js';
import { buildApp, staticCacheControl } from '../src/app.js';
import { seed } from '../src/seed.js';
import { runTierReview } from '../src/services/jobs.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/odonut_test';

let app: FastifyInstance;
let db: Db;
const mail: { to: string; subject: string; text: string }[] = [];
let owner = '';

const cookieOf = (res: LightMyRequestResponse, name: string) => `${name}=${res.cookies.find((c) => c.name === name)!.value}`;
const call = (method: string, url: string, o: { cookie?: string; body?: unknown; ip?: string } = {}) =>
  app.inject({ method: method as any, url, payload: o.body as any, remoteAddress: o.ip, headers: o.cookie ? { cookie: o.cookie } : {} });
const lastCode = (email: string) => mail.filter((m) => m.to === email).at(-1)!.text.match(/\b(\d{6})\b/)![1];

let nextPhone = 60002222;
async function signUp(email: string, first = 'Pat') {
  await call('POST', '/api/auth/otp', { body: { email } });
  let r = await call('POST', '/api/auth/verify', { body: { email, code: lastCode(email) } });
  r = await call('POST', '/api/auth/signup', {
    cookie: cookieOf(r, 'od_su'),
    body: { firstName: first, lastName: 'Lee', phone: `+852 ${nextPhone++}`, birthday: '1991-02-02', gender: 'undisclosed', marketingOptIn: true, acceptTerms: true },
  });
  assert.equal(r.statusCode, 200, r.body);
  return cookieOf(r, 'od_c');
}

before(async () => {
  db = createPool(DB_URL);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db, () => {});
  await seed(db, { adminEmail: 'owner@example.com', adminPassword: 'correct horse battery', log: () => {} });
  await db.query('UPDATE program SET verify_phone_at_signup = false');
  const cfg = loadConfig({ APP_SECRET: 'p'.repeat(40), PUBLIC_URL: 'https://loyalty.example.com', DATABASE_URL: DB_URL, WEB_DIST: '/nonexistent' } as any);
  app = await buildApp(cfg, db, { logger: false, mailer: { send: async (to, subject, text) => void mail.push({ to, subject, text }) } });
  const r = await call('POST', '/api/staff/login', { body: { email: 'owner@example.com', password: 'correct horse battery' } });
  owner = cookieOf(r, 'od_s');
});

after(async () => {
  await app?.close();
  await db?.end();
});

test('the dashboard counts days in Hong Kong time, not the server clock', async () => {
  await signUp('early@example.com');
  // Half past midnight in Hong Kong is still "yesterday" in UTC.
  const today = new Date(Date.now() + 8 * 3600_000).toISOString().slice(0, 10);
  await db.query(`UPDATE customers SET created_at = $1::timestamptz WHERE email = 'early@example.com'`, [`${today}T00:30:00+08:00`]);
  const d = (await call('GET', '/api/admin/dashboard', { cookie: owner })).json();
  assert.equal(d.daily.length, 30);
  assert.equal(d.daily.at(-1).day, today);
  assert.equal(d.daily.at(-1).signups, 1);
  assert.equal(d.totals.members, 1);
  // Shops in half-hour time zones work too.
  const { dashboard } = await import('../src/services/analytics.js');
  assert.equal((await dashboard(db, null, 5.5)).daily.length, 30);
});

test('member search treats % and _ as ordinary characters', async () => {
  await signUp('under_score@example.com', 'Una');
  let r = await call('GET', '/api/admin/customers?q=%25', { cookie: owner });
  assert.equal(r.json().total, 0, 'a lone % must not match everyone');
  r = await call('GET', '/api/admin/customers?q=under_s', { cookie: owner });
  assert.equal(r.json().total, 1);
  r = await call('GET', '/api/admin/customers?q=una', { cookie: owner });
  assert.equal(r.json().rows[0].email, 'under_score@example.com');
});

test('guesses sent all at once still get only five tries at a sign-in code', async () => {
  const email = 'guess@example.com';
  await call('POST', '/api/auth/otp', { body: { email } });
  const right = lastCode(email);
  const wrong = right === '000000' ? '111111' : '000000';
  const results = await Promise.all(
    Array.from({ length: 12 }, (_, i) => call('POST', '/api/auth/verify', { body: { email, code: wrong }, ip: `10.9.0.${i + 1}` })),
  );
  assert.equal(results.filter((r) => r.json().code === 'invalid').length, 5);
  const r = await call('POST', '/api/auth/verify', { body: { email, code: right }, ip: '10.9.1.1' });
  assert.equal(r.json().code, 'expired', 'the code is used up after five tries');
});

test('the Apple Wallet log endpoint stores at most 10 short lines per call', async () => {
  const r = await call('POST', '/api/wallet/apple/v1/log', { body: { logs: Array.from({ length: 50 }, () => 'x'.repeat(5000)) } });
  assert.equal(r.statusCode, 200);
  const n = await db.query(`SELECT count(*)::int AS n, max(length(message))::int AS len FROM apple_logs`);
  assert.equal(n.rows[0].n, 10);
  assert.equal(n.rows[0].len, 1000);
});

test('the shop settings may be cached briefly; personal data never', async () => {
  assert.equal((await call('GET', '/api/public/config')).headers['cache-control'], 'private, max-age=30');
  const me = await signUp('cache@example.com');
  assert.equal((await call('GET', '/api/me', { cookie: me })).headers['cache-control'], 'no-store');
});

test('built files are cached for a year, the page itself is always re-checked', () => {
  assert.equal(staticCacheControl('/app/web/dist/assets/index-BvlVXSDM.js'), 'public, max-age=31536000, immutable');
  assert.equal(staticCacheControl('/app/web/dist/assets/rolldown-runtime-WkwZ5CU-.js'), 'public, max-age=31536000, immutable');
  assert.equal(staticCacheControl('/app/web/dist/index.html'), 'no-cache');
  assert.equal(staticCacheControl('/app/web/dist/sw.js'), 'no-cache');
  assert.equal(staticCacheControl('/app/web/dist/icon-192.png'), 'public, max-age=86400');
});

test('the nightly tier review only touches members whose tier changes', async () => {
  const tiers = await db.query(`SELECT id, min_stamps FROM tiers ORDER BY min_stamps`);
  const [base, glazed] = tiers.rows;
  // Everyone sits on the starting tier with no stamps: nothing to change.
  assert.equal(await runTierReview(db, app.svc.notifier, () => {}), 0);
  // One member was put on Glazed but has no stamps to back it: moved back down.
  const c = await db.query(`UPDATE customers SET tier_id = $1 WHERE email = 'early@example.com' RETURNING id`, [glazed.id]);
  assert.equal(await runTierReview(db, app.svc.notifier, () => {}), 1);
  const after = await db.query(`SELECT tier_id FROM customers WHERE id = $1`, [c.rows[0].id]);
  assert.equal(after.rows[0].tier_id, base.id);
});

test('the queries behind busy pages use indexes', async () => {
  // Enough rows that Postgres prefers an index when one fits.
  await db.query(`
    INSERT INTO customers (email, first_name, last_name, phone, referral_code, created_at)
    SELECT 'bulk' || g || '@example.com', 'Bulk', 'Member' || g, '+8525' || lpad(g::text, 7, '0'), 'B' || g, now() - (g || ' minutes')::interval
      FROM generate_series(1, 20000) g`);
  await db.query('ANALYZE customers');
  const plan = async (sql: string, params: unknown[] = []) =>
    (await db.query(`EXPLAIN ${sql}`, params)).rows.map((r) => r['QUERY PLAN']).join('\n');
  assert.match(await plan(`SELECT count(*) FROM customers WHERE created_at > now() - interval '7 days'`), /customers_created_idx/);
  assert.match(await plan(`SELECT id FROM customers WHERE lower(email) LIKE $1`, ['%bulk1234%']), /customers_email_trgm_idx/);
  assert.match(
    await plan(`SELECT id FROM customers WHERE right(regexp_replace(coalesce(phone,''), '\\D', '', 'g'), 8) = right($1, 8)`, ['85260001234']),
    /customers_phone_tail_idx/,
  );
});
