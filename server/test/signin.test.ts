// Sign in with Google, one account per mobile number, welcome gifts once per person, and the
// text-code check on a new member's mobile.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { loadConfig } from '../src/config.js';
import { createPool, migrate, type Db } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { seed } from '../src/seed.js';
import { emailKey } from '../src/services/identity.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/odonut_test';
const CLIENT_ID = '1234-abc.apps.googleusercontent.com';

let app: FastifyInstance;
let db: Db;
let owner = '';
let signKey: CryptoKey;
const mail: { to: string; text: string }[] = [];
const texts: { to: string; body: string }[] = [];

const cookieOf = (res: LightMyRequestResponse, name: string) => `${name}=${res.cookies.find((c) => c.name === name)!.value}`;
const call = (method: string, url: string, o: { cookie?: string; body?: unknown } = {}) =>
  app.inject({ method: method as any, url, payload: o.body as any, headers: o.cookie ? { cookie: o.cookie } : {} });

const googleToken = (claims: Record<string, unknown>, aud = CLIENT_ID) =>
  new SignJWT({ email_verified: true, ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'test' })
    .setIssuer('https://accounts.google.com')
    .setAudience(aud)
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(signKey);

const profile = (phone: string, extra: Record<string, unknown> = {}) => ({
  firstName: 'Gia',
  lastName: 'Ho',
  phone,
  birthday: '1995-03-04',
  gender: 'female',
  acceptTerms: true,
  ...extra,
});

/** Email code sign-up up to the profile step; returns the sign-up cookie. */
async function emailStart(email: string) {
  await call('POST', '/api/auth/otp', { body: { email } });
  const code = mail.filter((m) => m.to === email).at(-1)!.text.match(/\b(\d{6})\b/)![1];
  const r = await call('POST', '/api/auth/verify', { body: { email, code } });
  assert.equal(r.json().status, 'signup');
  return cookieOf(r, 'od_su');
}

before(async () => {
  db = createPool(DB_URL);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db, () => {});
  await seed(db, { adminEmail: 'owner@example.com', adminPassword: 'correct horse battery', log: () => {} });
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  signKey = privateKey;
  const jwk = { ...(await exportJWK(publicKey)), kid: 'test', alg: 'RS256' };
  const cfg = loadConfig({ APP_SECRET: 'g'.repeat(40), PUBLIC_URL: 'https://loyalty.example.com', DATABASE_URL: DB_URL, WEB_DIST: '/nonexistent' } as any);
  app = await buildApp(cfg, db, {
    logger: false,
    mailer: { send: async (to, _s, text) => void mail.push({ to, text }) },
    sms: { enabled: true, send: async (to, body) => void texts.push({ to, body }) },
    googleKeys: createLocalJWKSet({ keys: [jwk] }),
  });
  const r = await call('POST', '/api/staff/login', { body: { email: 'owner@example.com', password: 'correct horse battery' } });
  owner = cookieOf(r, 'od_s');
});

after(async () => {
  await app?.close();
  await db?.end();
});

test('Google sign-in is off until the owner adds a client ID', async () => {
  assert.equal((await call('GET', '/api/public/config')).json().googleClientId, null);
  let r = await call('POST', '/api/auth/google', { body: { credential: await googleToken({ sub: 'g1', email: 'gia@gmail.com' }) } });
  assert.equal(r.statusCode, 400);
  r = await call('PATCH', '/api/admin/program', { cookie: owner, body: { google_client_id: 'not-a-client-id' } });
  assert.equal(r.statusCode, 400);
  r = await call('PATCH', '/api/admin/program', { cookie: owner, body: { google_client_id: CLIENT_ID } });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal((await call('GET', '/api/public/config')).json().googleClientId, CLIENT_ID);
});

test('a new Google user fills in a short profile, confirms their mobile by text, and joins', async () => {
  let r = await call('POST', '/api/auth/google', { body: { credential: await googleToken({ sub: 'g1', email: 'Gia@gmail.com', given_name: 'Gia', family_name: 'Ho' }) } });
  assert.equal(r.statusCode, 200, r.body);
  assert.deepEqual(r.json(), { status: 'signup', email: 'gia@gmail.com', firstName: 'Gia', lastName: 'Ho' });
  const su = cookieOf(r, 'od_su');

  // The mobile must be confirmed first.
  r = await call('POST', '/api/auth/signup', { cookie: su, body: profile('+85261110001') });
  assert.equal(r.json().code, 'phone_code_required');
  r = await call('POST', '/api/auth/signup/phone-code', { cookie: su, body: { phone: '+852 6111 0001' } });
  assert.equal(r.json().required, true);
  const code = texts.at(-1)!.body.match(/\b(\d{6})\b/)![1];
  assert.equal(texts.at(-1)!.to, '+85261110001');
  r = await call('POST', '/api/auth/signup', { cookie: su, body: profile('+85261110001', { phoneCode: '000000' === code ? '111111' : '000000' }) });
  assert.equal(r.json().code, 'invalid');
  r = await call('POST', '/api/auth/signup', { cookie: su, body: profile('+85261110001', { phoneCode: code }) });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().welcomeVouchers.length, 1);
  assert.equal(r.json().welcomeAlreadyClaimed, false);
  const row = await db.query("SELECT google_sub FROM customers WHERE email = 'gia@gmail.com'");
  assert.equal(row.rows[0].google_sub, 'g1');
});

test('returning Google users go straight in, even after changing their Gmail address', async () => {
  let r = await call('POST', '/api/auth/google', { body: { credential: await googleToken({ sub: 'g1', email: 'gia.new@gmail.com' }) } });
  assert.deepEqual(r.json(), { status: 'ok' });
  assert.equal((await call('GET', '/api/me', { cookie: cookieOf(r, 'od_c') })).json().first_name, 'Gia');
});

test('an existing email member who uses Google for the first time is linked, not duplicated', async () => {
  await db.query('UPDATE program SET verify_phone_at_signup = false');
  const su = await emailStart('ken@example.com');
  await call('POST', '/api/auth/signup', { cookie: su, body: profile('+85261110002', { firstName: 'Ken' }) });
  const r = await call('POST', '/api/auth/google', { body: { credential: await googleToken({ sub: 'g2', email: 'ken@example.com' }) } });
  assert.deepEqual(r.json(), { status: 'ok' });
  const rows = await db.query("SELECT google_sub FROM customers WHERE email = 'ken@example.com'");
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].google_sub, 'g2');
});

test('bad Google tokens are refused', async () => {
  const cases = [
    await googleToken({ sub: 'g9', email: 'x@gmail.com' }, 'someone-else.apps.googleusercontent.com'),
    await googleToken({ sub: 'g9', email: 'x@gmail.com', email_verified: false }),
    'eyJhbGciOiJub25lIn0.eyJzdWIiOiJ4In0.signature-that-is-long-enough',
  ];
  for (const credential of cases) {
    const r = await call('POST', '/api/auth/google', { body: { credential } });
    assert.equal(r.statusCode, 401, r.body);
  }
});

test('one account per mobile number, however it is typed', async () => {
  const su = await emailStart('copycat@example.com');
  const r = await call('POST', '/api/auth/signup', { cookie: su, body: profile('+852 6111 0002') });
  assert.equal(r.statusCode, 409);
  assert.equal(r.json().code, 'phone_taken');
  // Nor can a member move their number onto someone else's.
  const me = await call('POST', '/api/auth/signup', { cookie: su, body: profile('+85261110003') });
  assert.equal(me.statusCode, 200, me.body);
  const r2 = await call('PATCH', '/api/me', { cookie: cookieOf(me, 'od_c'), body: { phone: '+85261110001' } });
  assert.equal(r2.statusCode, 409);
});

test('deleting an account and joining again does not give the welcome gift twice', async () => {
  let su = await emailStart('lucy@gmail.com');
  let r = await call('POST', '/api/auth/signup', { cookie: su, body: profile('+85261110004') });
  assert.equal(r.json().welcomeVouchers.length, 1);
  await call('DELETE', '/api/me', { cookie: cookieOf(r, 'od_c') });

  // Same number, new email: an account, but no second gift or welcome stamp.
  su = await emailStart('lucy.again@example.com');
  r = await call('POST', '/api/auth/signup', { cookie: su, body: profile('+85261110004') });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.json().welcomeVouchers.length, 0);
  assert.equal(r.json().welcomeStamps, 0);
  assert.equal(r.json().welcomeAlreadyClaimed, true);

  // A Gmail alias of the first address reaches the same inbox, so no gift either.
  su = await emailStart('l.u.c.y+donuts@gmail.com');
  r = await call('POST', '/api/auth/signup', { cookie: su, body: profile('+85261110005') });
  assert.equal(r.json().welcomeAlreadyClaimed, true);

  // Someone genuinely new still gets everything.
  su = await emailStart('newbie@example.com');
  r = await call('POST', '/api/auth/signup', { cookie: su, body: profile('+85261110006') });
  assert.equal(r.json().welcomeVouchers.length, 1);
  assert.equal(r.json().welcomeStamps, 1);
});

test('email keys match the way Gmail delivers mail', () => {
  assert.equal(emailKey('L.U.C.Y+x@GoogleMail.com'), 'lucy@gmail.com');
  assert.equal(emailKey('first.last+tag@example.com'), 'first.last@example.com');
});
