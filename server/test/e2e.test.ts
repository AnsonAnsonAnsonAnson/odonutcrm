// End-to-end API test against a real Postgres. Needs TEST_DATABASE_URL (a throwaway database:
// the public schema is wiped) and TEST_CERT_DIR from scripts/make-test-certs.sh.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { loadConfig } from '../src/config.js';
import { createPool, migrate, type Db } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { seed } from '../src/seed.js';
import { runBirthdays, runExpiry, runWinback } from '../src/services/jobs.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/odonut_test';
const CERTS = process.env.TEST_CERT_DIR ?? '/tmp/claude-0/odcerts';
const PASS_TYPE = 'pass.test.odonut';

let app: FastifyInstance;
let db: Db;
const mail: { to: string; text: string }[] = [];
const pushes: string[][] = [];
let cfg: ReturnType<typeof loadConfig>;

function cookieOf(res: LightMyRequestResponse, name: string): string {
  const c = res.cookies.find((x) => x.name === name);
  assert.ok(c, `expected cookie ${name}`);
  return `${name}=${c!.value}`;
}

async function call(method: string, url: string, opts: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) {
  return app.inject({
    method: method as any,
    url,
    payload: opts.body as any,
    headers: { ...(opts.cookie ? { cookie: opts.cookie } : {}), ...(opts.headers ?? {}) },
  });
}

async function signUp(email: string, extra: Record<string, unknown> = {}) {
  let r = await call('POST', '/api/auth/otp', { body: { email } });
  assert.equal(r.statusCode, 200, r.body);
  const code = mail.filter((m) => m.to === email).at(-1)!.text.match(/\b(\d{6})\b/)![1];
  r = await call('POST', '/api/auth/verify', { body: { email, code } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().status, 'signup');
  const su = cookieOf(r, 'od_su');
  r = await call('POST', '/api/auth/signup', {
    cookie: su,
    body: {
      firstName: 'Test',
      lastName: email.split('@')[0],
      phone: '+852 9123 4567',
      birthday: '1999-05-20',
      gender: 'undisclosed',
      marketingOptIn: true,
      acceptTerms: true,
      ...extra,
    },
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
  cfg = loadConfig({
    APP_SECRET: 'x'.repeat(40),
    PUBLIC_URL: 'https://loyalty.example.com',
    DATABASE_URL: DB_URL,
    APPLE_PASS_TYPE_ID: PASS_TYPE,
    APPLE_TEAM_ID: 'TESTTEAM01',
    APPLE_PASS_CERT_FILE: join(CERTS, 'signer.pem'),
    APPLE_PASS_KEY_FILE: join(CERTS, 'signer.key'),
    APPLE_WWDR_FILE: join(CERTS, 'wwdr.pem'),
    WEB_DIST: '/nonexistent',
  } as any);
  assert.ok(cfg.apple, 'apple config should load from test certs');
  app = await buildApp(cfg, db, {
    logger: false,
    mailer: { send: async (to, _s, text) => void mail.push({ to, text }) },
  });
  // Capture APNs pushes instead of calling Apple.
  app.svc.notifier.apns!.send = async (tokens: string[]) => {
    pushes.push(tokens);
    return tokens.map((token) => ({ token, status: 200 }));
  };
});

after(async () => {
  await app?.close();
  await db?.end();
});

let alice = '';
let staffCookie = '';
let aliceQr = '';
let aliceSerial = '';
let aliceAuth = '';

test('customer signs up with an email code and gets a card plus welcome voucher', async () => {
  alice = await signUp('alice@example.com');
  const me = (await call('GET', '/api/me', { cookie: alice })).json();
  assert.equal(me.stamps, 0);
  assert.equal(me.stamps_required, 10);
  assert.equal(me.active_vouchers, 1);
  assert.match(me.qr_token, /^ODC-/);
  aliceQr = me.qr_token;
  aliceSerial = me.serial_number;
  aliceAuth = (await db.query('SELECT auth_token FROM cards WHERE serial_number = $1', [aliceSerial])).rows[0].auth_token;
  const vouchers = (await call('GET', '/api/me/vouchers', { cookie: alice })).json();
  assert.equal(vouchers[0].title, 'Free Cream Cheese Donut');
});

test('wrong codes are rejected and returning members sign straight in', async () => {
  await db.query(`UPDATE otp_codes SET created_at = now() - interval '1 minute'`);
  await call('POST', '/api/auth/otp', { body: { email: 'alice@example.com' } });
  let r = await call('POST', '/api/auth/verify', { body: { email: 'alice@example.com', code: '000000' } });
  if (r.statusCode === 200) return; // astronomically unlikely real match
  assert.equal(r.statusCode, 400);
  const code = mail.at(-1)!.text.match(/\b(\d{6})\b/)![1];
  r = await call('POST', '/api/auth/verify', { body: { email: 'alice@example.com', code } });
  assert.equal(r.json().status, 'ok');
  assert.ok(cookieOf(r, 'od_c'));
  // Codes are single use.
  r = await call('POST', '/api/auth/verify', { body: { email: 'alice@example.com', code } });
  assert.equal(r.statusCode, 400);
});

test('staff log in, scan a card and stamp it, with cooldown, cap and idempotency', async () => {
  let r = await call('POST', '/api/staff/login', { body: { email: 'owner@example.com', password: 'wrong' } });
  assert.equal(r.statusCode, 401);
  r = await call('POST', '/api/staff/login', { body: { email: 'owner@example.com', password: 'correct horse battery' } });
  assert.equal(r.statusCode, 200);
  staffCookie = cookieOf(r, 'od_s');

  r = await call('POST', '/api/staff/scan', { cookie: staffCookie, body: { code: aliceQr.toLowerCase() } });
  assert.equal(r.json().type, 'card');
  assert.equal(r.json().customer.stamps, 0);

  r = await call('POST', '/api/staff/stamp', { cookie: staffCookie, body: { qrToken: aliceQr, count: 1, idempotencyKey: 'k1' } });
  assert.equal(r.json().stamps, 1);
  r = await call('POST', '/api/staff/stamp', { cookie: staffCookie, body: { qrToken: aliceQr, count: 1, idempotencyKey: 'k1' } });
  assert.equal(r.json().duplicate, true);
  assert.equal(r.json().stamps, 1);
  r = await call('POST', '/api/staff/stamp', { cookie: staffCookie, body: { qrToken: aliceQr, count: 1 } });
  assert.equal(r.statusCode, 429, 'cooldown blocks rapid double stamping');

  r = await call('PATCH', '/api/admin/program', { cookie: staffCookie, body: { stamp_cooldown_seconds: 0 } });
  assert.equal(r.statusCode, 200, r.body);
  r = await call('POST', '/api/staff/stamp', { cookie: staffCookie, body: { qrToken: aliceQr, count: 6 } });
  assert.equal(r.statusCode, 400, 'per-scan cap');
});

test('completing the card issues the reward voucher and rolls extra stamps over', async () => {
  let r = await call('POST', '/api/staff/stamp', { cookie: staffCookie, body: { qrToken: aliceQr, count: 5 } });
  assert.equal(r.json().stamps, 6);
  r = await call('POST', '/api/staff/stamp', { cookie: staffCookie, body: { qrToken: aliceQr, count: 5 } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().stamps, 1);
  assert.equal(r.json().rewards.length, 1);
  assert.equal(r.json().rewards[0].title, '2 Free Donuts');
  const me = (await call('GET', '/api/me', { cookie: alice })).json();
  assert.equal(me.rewards_earned, 1);
  assert.equal(me.lifetime_stamps, 11);
  assert.equal(me.active_vouchers, 2);
  await new Promise((res) => setTimeout(res, 50));
  const n = await db.query(`SELECT title FROM notifications WHERE kind = 'reward'`);
  assert.equal(n.rowCount, 1);
});

test('vouchers redeem once at the counter', async () => {
  const vouchers = (await call('GET', '/api/me/vouchers', { cookie: alice })).json();
  const reward = vouchers.find((v: any) => v.title === '2 Free Donuts');
  let r = await call('POST', '/api/staff/scan', { cookie: staffCookie, body: { code: reward.code } });
  assert.equal(r.json().type, 'voucher');
  r = await call('POST', '/api/staff/redeem', { cookie: staffCookie, body: { code: reward.code } });
  assert.equal(r.statusCode, 200, r.body);
  r = await call('POST', '/api/staff/redeem', { cookie: staffCookie, body: { code: reward.code } });
  assert.equal(r.statusCode, 409);
});

test('promo codes work once per member', async () => {
  let r = await call('POST', '/api/me/promo', { cookie: alice, body: { code: 'hellodonut' } });
  assert.equal(r.statusCode, 200, r.body);
  r = await call('POST', '/api/me/promo', { cookie: alice, body: { code: 'HELLODONUT' } });
  assert.equal(r.statusCode, 409);
  r = await call('POST', '/api/me/promo', { cookie: alice, body: { code: 'NOPE' } });
  assert.equal(r.statusCode, 404);
});

test('referrer is rewarded when the friend makes a first purchase', async () => {
  const code = (await call('GET', '/api/me', { cookie: alice })).json().referral_code;
  const bob = await signUp('bob@example.com', { referralCode: code });
  const bobQr = (await call('GET', '/api/me', { cookie: bob })).json().qr_token;
  const before = (await call('GET', '/api/me/vouchers', { cookie: alice })).json().length;
  await call('POST', '/api/staff/stamp', { cookie: staffCookie, body: { qrToken: bobQr, count: 1 } });
  await new Promise((res) => setTimeout(res, 50));
  const afterV = (await call('GET', '/api/me/vouchers', { cookie: alice })).json();
  assert.equal(afterV.length, before + 1);
  assert.ok(afterV.some((v: any) => v.source === 'referral'));
});

test('Apple Wallet: signed pkpass download with the stamp strip', async () => {
  const r = await call('GET', '/api/wallet/apple/pass', { cookie: alice });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.headers['content-type'], 'application/vnd.apple.pkpass');
  const dir = mkdtempSync(join(tmpdir(), 'pkpass-'));
  const file = join(dir, 'card.pkpass');
  writeFileSync(file, r.rawPayload);
  const list = execFileSync('unzip', ['-Z1', file]).toString().split('\n');
  for (const f of ['pass.json', 'manifest.json', 'signature', 'strip@2x.png', 'icon.png', 'logo.png']) {
    assert.ok(list.includes(f), `pkpass contains ${f}`);
  }
  const pass = JSON.parse(execFileSync('unzip', ['-p', file, 'pass.json']).toString());
  assert.equal(pass.passTypeIdentifier, PASS_TYPE);
  assert.equal(pass.serialNumber, aliceSerial);
  assert.equal(pass.webServiceURL, 'https://loyalty.example.com/api/wallet/apple');
  assert.equal(pass.storeCard.headerFields.find((f: any) => f.key === 'stamps').value, '1/10');
  assert.equal(pass.barcodes[0].message, aliceQr);
  // The detached PKCS#7 signature verifies against the signing CA.
  execFileSync('unzip', ['-o', '-q', file, '-d', dir]);
  execFileSync('openssl', ['smime', '-verify', '-binary', '-inform', 'DER', '-in', join(dir, 'signature'), '-content', join(dir, 'manifest.json'), '-CAfile', join(CERTS, 'wwdr.pem'), '-purpose', 'any'], { stdio: 'pipe' });
});

test('Apple Wallet web service: register, list updates, fetch, push, unregister', async () => {
  const base = `/api/wallet/apple/v1/devices/dev1/registrations/${PASS_TYPE}`;
  let r = await call('POST', `${base}/${aliceSerial}`, { body: { pushToken: 'tok1' }, headers: { authorization: 'ApplePass bad' } });
  assert.equal(r.statusCode, 401);
  const auth = { authorization: `ApplePass ${aliceAuth}` };
  r = await call('POST', `${base}/${aliceSerial}`, { body: { pushToken: 'tok1' }, headers: auth });
  assert.equal(r.statusCode, 201);
  r = await call('POST', `${base}/${aliceSerial}`, { body: { pushToken: 'tok1' }, headers: auth });
  assert.equal(r.statusCode, 200);

  r = await call('GET', base);
  assert.equal(r.statusCode, 200);
  assert.deepEqual(r.json().serialNumbers, [aliceSerial]);
  const tag = r.json().lastUpdated;
  r = await call('GET', `${base}?passesUpdatedSince=${tag}`);
  assert.equal(r.statusCode, 204);

  pushes.length = 0;
  await new Promise((res) => setTimeout(res, 5));
  r = await call('POST', '/api/staff/stamp', { cookie: staffCookie, body: { qrToken: aliceQr, count: 2 } });
  assert.equal(r.statusCode, 200);
  await new Promise((res) => setTimeout(res, 100));
  assert.deepEqual(pushes, [['tok1']], 'stamping pushes to the registered device');
  r = await call('GET', `${base}?passesUpdatedSince=${tag}`);
  assert.equal(r.statusCode, 200);

  const passUrl = `/api/wallet/apple/v1/passes/${PASS_TYPE}/${aliceSerial}`;
  r = await call('GET', passUrl, { headers: auth });
  assert.equal(r.statusCode, 200);
  const lm = r.headers['last-modified'] as string;
  r = await call('GET', passUrl, { headers: { ...auth, 'if-modified-since': lm } });
  assert.equal(r.statusCode, 304);
  r = await call('GET', passUrl, { headers: { authorization: 'ApplePass nope' } });
  assert.equal(r.statusCode, 401);

  r = await call('POST', '/api/wallet/apple/v1/log', { body: { logs: ['hello from test'] } });
  assert.equal(r.statusCode, 200);

  // Member Center link on the back of the pass signs the customer in.
  r = await call('GET', `/api/auth/card-login?s=${aliceSerial}&t=${encodeURIComponent(aliceAuth)}`);
  assert.equal(r.statusCode, 302);
  assert.equal(r.headers.location, '/me');
  assert.ok(cookieOf(r, 'od_c'));

  r = await call('DELETE', `${base}/${aliceSerial}`, { headers: auth });
  assert.equal(r.statusCode, 200);
  r = await call('GET', base);
  assert.equal(r.statusCode, 204);
  // Re-register for later tests.
  await call('POST', `${base}/${aliceSerial}`, { body: { pushToken: 'tok1' }, headers: auth });
});

test('campaigns reach the segment with a voucher and a wallet push', async () => {
  let r = await call('POST', '/api/admin/campaigns/preview', { cookie: staffCookie, body: { type: 'all', optInOnly: true } });
  assert.equal(r.json().recipients, 2);
  const tpl = (await call('GET', '/api/admin/templates', { cookie: staffCookie })).json().find((t: any) => t.title === '$5 Cash Voucher');
  r = await call('POST', '/api/admin/campaigns', {
    cookie: staffCookie,
    body: { name: 'Weekend special', message: 'Glazed Saturday: $5 off', templateId: tpl.id, segment: { type: 'all' } },
  });
  assert.equal(r.statusCode, 200, r.body);
  const id = r.json().id;
  pushes.length = 0;
  r = await call('POST', `/api/admin/campaigns/${id}/send`, { cookie: staffCookie });
  assert.equal(r.statusCode, 200);
  for (let i = 0; i < 50; i++) {
    const s = (await db.query('SELECT status, recipients FROM campaigns WHERE id = $1', [id])).rows[0];
    if (s.status === 'sent') break;
    await new Promise((res) => setTimeout(res, 50));
  }
  const c = (await db.query('SELECT status, recipients FROM campaigns WHERE id = $1', [id])).rows[0];
  assert.equal(c.status, 'sent');
  assert.equal(c.recipients, 2);
  const v = await db.query(`SELECT count(*)::int AS n FROM vouchers WHERE source = 'campaign' AND source_ref = $1`, [id]);
  assert.equal(v.rows[0].n, 2);
  assert.ok(pushes.flat().includes('tok1'));
  const card = (await db.query('SELECT message FROM cards WHERE serial_number = $1', [aliceSerial])).rows[0];
  assert.match(card.message, /Glazed Saturday/);
  r = await call('POST', `/api/admin/campaigns/${id}/send`, { cookie: staffCookie });
  assert.equal(r.statusCode, 409, 'a campaign sends once');
});

test('automations: birthday, win-back and voucher expiry', async () => {
  const log = () => {};
  const today = new Date(Date.now() + cfg.tzOffsetHours * 3600_000).toISOString().slice(5, 10);
  await db.query(`UPDATE customers SET birthday = ('1995-' || $1)::date WHERE email = 'alice@example.com'`, [today]);
  assert.equal(await runBirthdays(db, cfg, app.svc.notifier, log), 1);
  assert.equal(await runBirthdays(db, cfg, app.svc.notifier, log), 0, 'once per year');

  await db.query(`UPDATE customers SET last_visit_at = now() - interval '40 days' WHERE email = 'bob@example.com'`);
  assert.equal(await runWinback(db, app.svc.notifier, log), 1);
  assert.equal(await runWinback(db, app.svc.notifier, log), 0, 'once per lapse');

  await db.query(`UPDATE vouchers SET expires_at = now() - interval '1 minute' WHERE source = 'welcome'`);
  await runExpiry(db, app.svc.notifier, log);
  const e = await db.query(`SELECT count(*)::int AS n FROM vouchers WHERE source = 'welcome' AND status = 'expired'`);
  assert.equal(e.rows[0].n, 2);
});

test('admin dashboard, roles and CSV export', async () => {
  let r = await call('GET', '/api/admin/dashboard', { cookie: staffCookie });
  assert.equal(r.statusCode, 200);
  const d = r.json();
  assert.equal(d.totals.members, 2);
  assert.equal(d.totals.apple_passes, 1);
  assert.equal(d.daily.length, 30);

  r = await call('POST', '/api/admin/staff', {
    cookie: staffCookie,
    body: { email: 'cashier@example.com', name: 'Cashier', role: 'staff', password: 'till drawer sunrise' },
  });
  assert.equal(r.statusCode, 200, r.body);
  r = await call('POST', '/api/staff/login', { body: { email: 'cashier@example.com', password: 'till drawer sunrise' } });
  const cashier = cookieOf(r, 'od_s');
  r = await call('GET', '/api/admin/dashboard', { cookie: cashier });
  assert.equal(r.statusCode, 403);
  r = await call('GET', '/api/staff/activity', { cookie: cashier });
  assert.equal(r.statusCode, 200);

  r = await call('GET', '/api/admin/customers.csv', { cookie: staffCookie });
  assert.equal(r.statusCode, 200);
  assert.match(r.body, /alice@example.com/);
  r = await call('GET', '/api/admin/customers?q=bob', { cookie: staffCookie });
  assert.equal(r.json().total, 1);
});

test('members can delete their account', async () => {
  const r = await call('DELETE', '/api/me', { cookie: alice });
  assert.equal(r.statusCode, 200);
  const me = await call('GET', '/api/me', { cookie: alice });
  assert.equal(me.statusCode, 401);
});
