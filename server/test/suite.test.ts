// Tests for tiers, the POS API, SMS sign-in, welcome email, near-reward nudges, and the
// Apple push / Google Wallet clients against local mocks. Same env as e2e.test.ts.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http2 from 'node:http2';
import { execFileSync } from 'node:child_process';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { loadConfig } from '../src/config.js';
import { createPool, migrate, type Db } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { seed } from '../src/seed.js';
import { runNearReward, runTierReview } from '../src/services/jobs.js';
import { Apns } from '../src/services/apple/apns.js';
import { GoogleWallet } from '../src/services/google/wallet.js';
import { getProgram, loadPassData } from '../src/services/program.js';
import { passJson } from '../src/services/apple/pass.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/odonut_test';
const CERTS = process.env.TEST_CERT_DIR ?? '/tmp/claude-0/odcerts';

let app: FastifyInstance;
let db: Db;
let cfg: ReturnType<typeof loadConfig>;
const mail: { to: string; subject: string; text: string }[] = [];
const texts: { to: string; body: string }[] = [];
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
    sms: { enabled: true, send: async (to, body) => void texts.push({ to, body }) },
  });
  app.svc.notifier.apns!.send = async (tokens: string[]) => tokens.map((token) => ({ token, status: 200 }));
  const r = await call('POST', '/api/staff/login', { body: { email: 'owner@example.com', password: 'correct horse battery' } });
  owner = cookieOf(r, 'od_s');
});

after(async () => {
  await app?.close();
  await db?.end();
});

let tess = '';

test('sign-up sends a welcome email with a Member Center link and starts at the first tier', async () => {
  tess = await signUp('tess@example.com', '+852 6123 4567');
  const welcome = mail.find((m) => m.to === 'tess@example.com' && /Welcome/.test(m.subject));
  assert.ok(welcome, 'welcome email sent');
  assert.match(welcome!.text, /https:\/\/loyalty\.example\.com\/api\/auth\/card-login\?s=OD/);
  assert.match(welcome!.text, /Free Cream Cheese Donut/);
  const me = (await call('GET', '/api/me', { cookie: tess })).json();
  assert.equal(me.tier.current.name, 'Sprinkle');
  assert.equal(me.tier.next.name, 'Glazed');
  assert.equal(me.tier.next.needed, 20);
});

test('reaching a tier threshold upgrades the member, issues the tier voucher and shows on the pass', async () => {
  const tiers = (await call('GET', '/api/admin/tiers', { cookie: owner })).json();
  const glazed = tiers.find((t: any) => t.name === 'Glazed');
  let r = await call('PATCH', `/api/admin/tiers/${glazed.id}`, {
    cookie: owner,
    body: { name: 'Glazed', minStamps: 3, perks: glazed.perks, upgradeTemplateId: glazed.upgrade_template_id, color: glazed.color },
  });
  assert.equal(r.statusCode, 200, r.body);
  const qr = (await call('GET', '/api/me', { cookie: tess })).json().qr_token;
  await call('POST', '/api/staff/stamp', { cookie: owner, body: { qrToken: qr, count: 3 } });
  await new Promise((res) => setTimeout(res, 80));
  const me = (await call('GET', '/api/me', { cookie: tess })).json();
  assert.equal(me.tier.current.name, 'Glazed');
  const vouchers = (await call('GET', '/api/me/vouchers', { cookie: tess })).json();
  assert.ok(vouchers.some((v: any) => v.title === 'Glazed Member Treat'));
  const n = await db.query(`SELECT title FROM notifications WHERE kind = 'tier'`);
  assert.equal(n.rows[0].title, 'Welcome to Glazed!');

  const data = (await loadPassData(db, { customerId: me.id }))!;
  const pj = passJson({ publicUrl: cfg.publicUrl, passTypeId: 'p', teamId: 't' }, await getProgram(db), data);
  assert.equal(pj.storeCard.headerFields[0].key, 'tier');
  assert.equal(pj.storeCard.headerFields[0].value, 'Glazed');

  // Stamps older than the window no longer count: the daily review moves the member down.
  await db.query(`UPDATE stamp_events SET created_at = now() - interval '400 days'`);
  assert.equal(await runTierReview(db, app.svc.notifier, () => {}), 1);
  assert.equal((await call('GET', '/api/me', { cookie: tess })).json().tier.current.name, 'Sprinkle');
  // Re-qualifying does not hand out the tier voucher a second time.
  await db.query(`UPDATE stamp_events SET created_at = now()`);
  await runTierReview(db, app.svc.notifier, () => {});
  const again = (await call('GET', '/api/me/vouchers', { cookie: tess })).json().filter((v: any) => v.title === 'Glazed Member Treat');
  assert.equal(again.length, 1);
});

test('existing members can sign in with an SMS code; unknown numbers cannot trigger texts', async () => {
  let r = await call('POST', '/api/auth/otp', { body: { phone: '+852 9999 0000' } });
  assert.equal(r.statusCode, 404);
  assert.equal(texts.length, 0);
  r = await call('POST', '/api/auth/otp', { body: { phone: '+85261234567' } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(texts[0].to, '+85261234567');
  const code = texts[0].body.match(/\b(\d{6})\b/)![1];
  r = await call('POST', '/api/auth/verify', { body: { phone: '+852 6123 4567', code } });
  assert.equal(r.json().status, 'ok');
  assert.ok(cookieOf(r, 'od_c'));
  r = await call('POST', '/api/auth/otp', { body: { phone: '+85261234567' } });
  assert.equal(r.statusCode, 429, 'per-number cooldown');
});

test('POS API: keys, stamping by phone with order-id idempotency, voucher redemption, revocation', async () => {
  let r = await call('POST', '/api/admin/api-keys', { cookie: owner, body: { name: 'Till 1' } });
  assert.equal(r.statusCode, 200, r.body);
  const { key, id } = r.json();
  assert.match(key, /^odk_/);
  const list = (await call('GET', '/api/admin/api-keys', { cookie: owner })).json();
  assert.equal(list[0].prefix, key.slice(0, 12));
  assert.ok(!('key_hash' in list[0]) && !('key' in list[0]));

  const auth = { authorization: `Bearer ${key}` };
  r = await call('POST', '/api/pos/v1/stamps', { body: { member: { phone: '61234567' }, count: 1, orderId: 'A1' }, headers: { authorization: 'Bearer odk_wrong' } });
  assert.equal(r.statusCode, 401);
  r = await call('GET', '/api/pos/v1/members/lookup?phone=61234567', { headers: auth });
  assert.equal(r.statusCode, 200, r.body);
  const before = r.json().member.stamps;
  r = await call('POST', '/api/pos/v1/stamps', { body: { member: { phone: '+852 6123 4567' }, count: 2, orderId: 'A1' }, headers: auth });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().stamps, before + 2);
  r = await call('POST', '/api/pos/v1/stamps', { body: { member: { phone: '61234567' }, count: 2, orderId: 'A1' }, headers: auth });
  assert.equal(r.json().duplicate, true);
  assert.equal(r.json().stamps, before + 2);

  const v = (await call('GET', '/api/pos/v1/members/lookup?email=tess@example.com', { headers: auth })).json().vouchers[0];
  r = await call('GET', `/api/pos/v1/vouchers/${v.code}`, { headers: auth });
  assert.equal(r.json().status, 'active');
  r = await call('POST', '/api/pos/v1/vouchers/redeem', { body: { code: v.code, orderId: 'A2' }, headers: auth });
  assert.equal(r.statusCode, 200, r.body);
  const audit = await db.query('SELECT redeemed_api_key_id FROM vouchers WHERE code = $1', [v.code]);
  assert.equal(audit.rows[0].redeemed_api_key_id, id);

  await call('DELETE', `/api/admin/api-keys/${id}`, { cookie: owner });
  r = await call('GET', '/api/pos/v1/members/lookup?phone=61234567', { headers: auth });
  assert.equal(r.statusCode, 401, 'revoked keys stop working');
});

test('near-reward nudge goes once to members close to a reward who have not visited lately', async () => {
  await db.query(`UPDATE cards SET stamps = 8`);
  await db.query(`UPDATE customers SET last_visit_at = now() - interval '10 days'`);
  assert.equal(await runNearReward(db, app.svc.notifier, () => {}), 1);
  assert.equal(await runNearReward(db, app.svc.notifier, () => {}), 0);
  const n = await db.query(`SELECT title FROM notifications WHERE kind = 'near_reward'`);
  assert.equal(n.rows[0].title, 'Just 2 stamps to go');
});

test('privacy policy is editable and public; segments can target a tier', async () => {
  let r = await call('PATCH', '/api/admin/program', { cookie: owner, body: { privacy_policy: 'We keep your data safe.' } });
  assert.equal(r.statusCode, 200, r.body);
  r = await call('GET', '/api/public/config');
  assert.equal(r.json().privacyPolicy, 'We keep your data safe.');
  assert.equal(r.json().smsSignIn, true);
  const tiers = (await call('GET', '/api/admin/tiers', { cookie: owner })).json();
  const glazed = tiers.find((t: any) => t.name === 'Glazed');
  r = await call('POST', '/api/admin/campaigns/preview', { cookie: owner, body: { type: 'tier', tierId: glazed.id } });
  assert.equal(r.json().recipients, 1);
});

test('APNs client sends the Wallet push format with the pass certificate (local HTTP/2 mock)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'apns-'));
  // Server certificate for localhost, signed by the test CA the client is told to trust.
  execFileSync('openssl', ['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(dir, 's.key'), '-out', join(dir, 's.csr'), '-subj', '/CN=localhost'], { stdio: 'pipe' });
  writeFileSync(join(dir, 'ext'), 'subjectAltName=DNS:localhost');
  execFileSync('openssl', ['x509', '-req', '-in', join(dir, 's.csr'), '-CA', join(CERTS, 'wwdr.pem'), '-CAkey', join(CERTS, 'wwdr.key'), '-CAcreateserial', '-out', join(dir, 's.pem'), '-days', '1', '-extfile', join(dir, 'ext')], { stdio: 'pipe' });
  const seen: any[] = [];
  const server = http2.createSecureServer({
    key: readFileSync(join(dir, 's.key')),
    cert: readFileSync(join(dir, 's.pem')),
    ca: readFileSync(join(CERTS, 'wwdr.pem')),
    requestCert: true,
    rejectUnauthorized: true,
  });
  server.on('stream', (stream, headers) => {
    let body = '';
    stream.on('data', (d) => (body += d));
    stream.on('end', () => {
      const peer = (stream.session?.socket as any).getPeerCertificate();
      seen.push({ path: headers[':path'], topic: headers['apns-topic'], body, clientCN: peer?.subject?.CN });
      const bad = String(headers[':path']).endsWith('/gone');
      stream.respond({ ':status': bad ? 410 : 200 });
      stream.end(bad ? JSON.stringify({ reason: 'Unregistered' }) : '');
    });
  });
  await new Promise<void>((res) => server.listen(0, res));
  const port = (server.address() as any).port;
  const apns = new Apns({ ...cfg.apple!, apnsHost: `https://localhost:${port}` }, () => {}, readFileSync(join(CERTS, 'wwdr.pem')));
  const results = await apns.send(['abc123', 'gone']);
  apns.close();
  server.close();
  assert.deepEqual(results.map((r) => r.status), [200, 410]);
  assert.equal(results[1].reason, 'Unregistered');
  assert.equal(seen[0].path, '/3/device/abc123');
  assert.equal(seen[0].topic, 'pass.test.odonut');
  assert.equal(seen[0].body, '{}');
  assert.equal(seen[0].clientCN, 'Pass Type ID: pass.test.odonut');
});

test('Google Wallet client signs a valid save link and calls the update API (mocked fetch)', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const g = new GoogleWallet(
    { issuerId: '3388000000012345', classId: '3388000000012345.odonut_stamp_card', clientEmail: 'wallet@proj.iam.gserviceaccount.com', privateKey: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() },
    cfg.publicUrl,
    () => {},
  );
  const program = await getProgram(db);
  const cust = (await db.query(`SELECT id FROM customers LIMIT 1`)).rows[0].id;
  const data = (await loadPassData(db, { customerId: cust }))!;

  const url = g.saveUrl(program, data);
  const jwt = url.split('/save/')[1];
  const [h, p, s] = jwt.split('.');
  const verify = createVerify('RSA-SHA256');
  verify.update(`${h}.${p}`);
  assert.ok(verify.verify(publicKey, Buffer.from(s, 'base64url')), 'JWT signature verifies');
  const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.equal(payload.typ, 'savetowallet');
  const obj = payload.payload.loyaltyObjects[0];
  assert.equal(obj.id, `3388000000012345.${data.card.serial_number}`);
  assert.equal(obj.barcode.value, data.card.qr_token);
  assert.equal(obj.loyaltyPoints.balance.string, `${data.card.stamps}/${program.stamps_required}`);

  const calls: { url: string; method: string; body: any }[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (u: any, init: any) => {
    calls.push({ url: String(u), method: init?.method ?? 'GET', body: init?.body });
    if (String(u).includes('oauth2')) return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { status: 200 });
    return new Response('{}', { status: 200 });
  }) as any;
  try {
    const ok = await g.updateObject(program, data, { header: 'Hi', body: 'Fresh batch!' });
    assert.equal(ok, true);
  } finally {
    globalThis.fetch = realFetch;
  }
  assert.match(calls[0].url, /oauth2\.googleapis\.com\/token/);
  assert.equal(calls[1].method, 'PATCH');
  assert.match(calls[1].url, /\/loyaltyObject\/3388000000012345\.OD/);
  assert.match(calls[2].url, /\/addMessage$/);
  assert.equal(JSON.parse(calls[2].body).message.messageType, 'TEXT_AND_NOTIFY');
});
