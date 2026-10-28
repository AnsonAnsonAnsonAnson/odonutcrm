// The CRM: ready-made groups, the member profile and the analytics behind the dashboard.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { loadConfig } from '../src/config.js';
import { createPool, migrate, type Db } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { seed } from '../src/seed.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/odonut_test';

let app: FastifyInstance;
let db: Db;
const mail: { to: string; subject: string; text: string }[] = [];
let owner = '';
const ids: Record<string, string> = {};
const cookies: Record<string, string> = {};

const cookieOf = (res: LightMyRequestResponse, name: string) => `${name}=${res.cookies.find((c) => c.name === name)!.value}`;
const call = (method: string, url: string, o: { cookie?: string; body?: unknown } = {}) =>
  app.inject({ method: method as any, url, payload: o.body as any, headers: o.cookie ? { cookie: o.cookie } : {} });

let nextPhone = 61110000;
async function signUp(key: string, optIn = true) {
  const email = `${key}@example.com`;
  await call('POST', '/api/auth/otp', { body: { email } });
  const code = mail.filter((m) => m.to === email).at(-1)!.text.match(/\b(\d{6})\b/)![1];
  let r = await call('POST', '/api/auth/verify', { body: { email, code } });
  r = await call('POST', '/api/auth/signup', {
    cookie: cookieOf(r, 'od_su'),
    body: { firstName: key, lastName: 'Test', phone: `+852 ${nextPhone++}`, birthday: '1990-01-15', gender: 'undisclosed', marketingOptIn: optIn, acceptTerms: true },
  });
  assert.equal(r.statusCode, 200, r.body);
  cookies[key] = cookieOf(r, 'od_c');
  ids[key] = (await db.query('SELECT id FROM customers WHERE email = $1', [email])).rows[0].id;
}

/** Purchases on a member's card, `daysAgo` each, with a bill amount. */
async function visits(key: string, list: { daysAgo: number; amount: number }[]) {
  for (const v of list) {
    await db.query(
      `INSERT INTO stamp_events (card_id, delta, reason, amount, note, created_at)
       SELECT id, 1, 'purchase', $2, 'counter', now() - make_interval(days => $3) FROM cards WHERE customer_id = $1`,
      [ids[key], v.amount, v.daysAgo],
    );
  }
  const last = Math.min(...list.map((v) => v.daysAgo));
  const total = list.reduce((n, v) => n + v.amount, 0);
  await db.query(
    `UPDATE customers SET visit_count = $2, last_visit_at = now() - make_interval(days => $3), total_spend = $4 WHERE id = $1`,
    [ids[key], list.length, last, total],
  );
}

before(async () => {
  db = createPool(DB_URL);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db, () => {});
  await seed(db, { adminEmail: 'owner@example.com', adminPassword: 'correct horse battery', log: () => {} });
  await db.query('UPDATE program SET verify_phone_at_signup = false');
  const cfg = loadConfig({ APP_SECRET: 'c'.repeat(40), PUBLIC_URL: 'https://loyalty.example.com', DATABASE_URL: DB_URL, WEB_DIST: '/nonexistent' } as any);
  app = await buildApp(cfg, db, { logger: false, mailer: { send: async (to, subject, text) => void mail.push({ to, subject, text }) } });
  const r = await call('POST', '/api/staff/login', { body: { email: 'owner@example.com', password: 'correct horse battery' } });
  owner = cookieOf(r, 'od_s');

  // A small shop's worth of members, one for each kind of customer.
  for (const k of ['newbie', 'ghost', 'once', 'regular', 'drifter', 'friend']) await signUp(k);
  await db.query(`UPDATE customers SET created_at = now() - interval '10 days' WHERE id = $1`, [ids.ghost]);
  await db.query(`UPDATE customers SET created_at = now() - interval '200 days' WHERE id = ANY($1)`, [[ids.once, ids.regular, ids.drifter, ids.friend]]);
  await visits('once', [{ daysAgo: 20, amount: 40 }]);
  await visits('regular', [{ daysAgo: 2, amount: 80 }, { daysAgo: 10, amount: 100 }, { daysAgo: 25, amount: 120 }]);
  await visits('drifter', [{ daysAgo: 40, amount: 30 }, { daysAgo: 70, amount: 30 }, { daysAgo: 90, amount: 30 }, { daysAgo: 100, amount: 30 }]);
  await visits('friend', [{ daysAgo: 90, amount: 45 }]);
  await db.query(`UPDATE customers SET referred_by = $2 WHERE id = $1`, [ids.friend, ids.newbie]);
  // The ghost's welcome donut runs out in 3 days.
  await db.query(`UPDATE vouchers SET expires_at = now() + interval '3 days' WHERE customer_id = $1`, [ids.ghost]);
});

after(async () => {
  await app?.close();
  await db?.end();
});

test('each ready-made group finds the right members', async () => {
  const r = await call('GET', '/api/admin/groups', { cookie: owner });
  assert.equal(r.statusCode, 200);
  const groups = r.json() as { id: string; members: number; reachable: number; idea: { message: string } }[];
  const size = Object.fromEntries(groups.map((g) => [g.id, g.members]));
  assert.deepEqual(
    { ...size, birthday: undefined },
    {
      new: 1, // newbie
      joined_no_visit: 1, // ghost
      one_visit: 2, // once and friend
      near_reward: 0,
      reward_waiting: 1, // ghost's donut expires in 3 days
      regulars: 1, // regular
      top_spenders: 1, // regular, $300
      at_risk: 1, // drifter, last seen 40 days ago
      lapsed: 1, // friend, last seen 90 days ago
      birthday: undefined,
      referrers: 1, // newbie brought friend
    },
  );
  assert.ok(groups.every((g) => g.idea.message.length > 0 && g.reachable <= g.members));
});

test('Members can be narrowed to a group, sorted by spend and downloaded', async () => {
  let r = await call('GET', '/api/admin/customers?group=one_visit&sort=spend', { cookie: owner });
  assert.equal(r.json().total, 2);
  assert.deepEqual(r.json().rows.map((x: any) => x.first_name), ['friend', 'once']);
  assert.equal(r.json().rows[0].total_spend, 45);
  r = await call('GET', '/api/admin/customers?group=one_visit&q=once', { cookie: owner });
  assert.equal(r.json().total, 1);
  r = await call('GET', '/api/admin/customers?group=nope', { cookie: owner });
  assert.equal(r.statusCode, 404);
  r = await call('GET', '/api/admin/customers.csv?group=at_risk', { cookie: owner });
  assert.match(r.headers['content-disposition'] as string, /members-at_risk\.csv/);
  const lines = r.body.trim().split('\n');
  assert.equal(lines.length, 2);
  assert.match(lines[0], /total_spend/);
  assert.match(lines[1], /drifter@example\.com/);
});

test('messages only reach the opted-in part of a group', async () => {
  await db.query('UPDATE customers SET marketing_opt_in = false WHERE id = $1', [ids.friend]);
  const groups = (await call('GET', '/api/admin/groups', { cookie: owner })).json();
  const oneVisit = groups.find((g: any) => g.id === 'one_visit');
  assert.equal(oneVisit.members, 2);
  assert.equal(oneVisit.reachable, 1);
  const r = await call('POST', '/api/admin/campaigns/preview', { cookie: owner, body: { ...oneVisit.segment } });
  assert.equal(r.json().recipients, 1);
  await db.query('UPDATE customers SET marketing_opt_in = true WHERE id = $1', [ids.friend]);
});

test('the profile shows spend, visits, groups and who they referred', async () => {
  let r = await call('GET', `/api/admin/customers/${ids.regular}`, { cookie: owner });
  const d = r.json();
  assert.equal(d.stats.bills, 3);
  assert.equal(d.stats.avg_bill, 100);
  assert.equal(d.stats.visits_90d, 3);
  assert.ok(d.stats.first_visit);
  assert.deepEqual(d.groups.sort(), ['regulars', 'top_spenders']);
  const purchase = d.history.find((h: any) => h.detail === 'purchase');
  assert.equal(purchase.amount, 80);
  assert.equal(purchase.note, 'counter');
  r = await call('GET', `/api/admin/customers/${ids.newbie}`, { cookie: owner });
  assert.deepEqual(r.json().referred.map((x: any) => x.first_name), ['friend']);
  assert.ok(r.json().groups.includes('referrers'));
});

test('members never see staff notes or bill amounts in their own history', async () => {
  const r = await call('GET', '/api/me/history', { cookie: cookies.regular });
  assert.equal(r.statusCode, 200);
  for (const h of r.json()) {
    assert.equal('note' in h, false);
    assert.equal('amount' in h, false);
    assert.equal('staff' in h, false);
  }
});

test('the dashboard reports visits, spend and how often members come', async () => {
  const d = (await call('GET', '/api/admin/dashboard', { cookie: owner })).json();
  assert.equal(d.spend.visits_30d, 4); // regular x3 + once
  assert.equal(d.spend.visitors_30d, 2);
  assert.equal(d.spend.spend_30d, 340);
  assert.equal(d.spend.avg_bill_30d, 85);
  assert.equal(d.spend.visits_prev_30d, 1); // drifter, 40 days ago
  assert.equal(d.totals.freq_0, 2);
  assert.equal(d.totals.freq_1, 2);
  assert.equal(d.totals.freq_3_5, 2);
  assert.equal(d.daily.reduce((n: number, x: any) => n + x.visits, 0), 4);
  assert.equal(d.daily.reduce((n: number, x: any) => n + x.spend, 0), 340);
});
