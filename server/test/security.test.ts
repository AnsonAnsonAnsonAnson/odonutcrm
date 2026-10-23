// Security: headers, cross-site request blocking, staff lockout, sign-out-everywhere,
// two-step sign-in with backup codes, the owner's "require two-step" switch and the activity log.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { loadConfig } from '../src/config.js';
import { createPool, migrate, type Db } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { seed } from '../src/seed.js';
import { currentStep, totpAt, verifyTotp } from '../src/lib/totp.js';
import { passwordProblem } from '../src/lib/security.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/odonut_test';
const OWNER = { email: 'owner@example.com', password: 'correct horse battery' };

let app: FastifyInstance;
let db: Db;
const mail: { to: string; text: string }[] = [];
let owner = '';

const cookieOf = (res: LightMyRequestResponse, name: string) => {
  const c = res.cookies.find((x) => x.name === name);
  assert.ok(c, `expected cookie ${name}`);
  return `${name}=${c!.value}`;
};
const call = (method: string, url: string, o: { cookie?: string; body?: unknown; headers?: Record<string, string> } = {}) =>
  app.inject({ method: method as any, url, payload: o.body as any, headers: { ...(o.cookie ? { cookie: o.cookie } : {}), ...(o.headers ?? {}) } });
const login = (email: string, password: string) => call('POST', '/api/staff/login', { body: { email, password } });

before(async () => {
  db = createPool(DB_URL);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db, () => {});
  await seed(db, { adminEmail: OWNER.email, adminPassword: OWNER.password, log: () => {} });
  const cfg = loadConfig({ APP_SECRET: 's'.repeat(40), PUBLIC_URL: 'https://loyalty.example.com', DATABASE_URL: DB_URL, WEB_DIST: '/nonexistent' } as any);
  app = await buildApp(cfg, db, { logger: false, mailer: { send: async (to, _s, text) => void mail.push({ to, text }) } });
  owner = cookieOf(await login(OWNER.email, OWNER.password), 'od_s');
});

after(async () => {
  await app?.close();
  await db?.end();
});

test('authenticator codes match the RFC 6238 test vector and are not accepted twice', () => {
  // RFC 6238 appendix B: ASCII secret "12345678901234567890", T = 59s -> 94287082 (last 6 digits).
  const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  assert.equal(totpAt(secret, 1), '287082');
  assert.equal(totpAt(secret, Math.floor(1111111109 / 30)), '081804');
  const now = Date.now();
  const code = totpAt(secret, currentStep(now));
  const step = verifyTotp(secret, code, null, now);
  assert.equal(step, currentStep(now));
  assert.equal(verifyTotp(secret, code, step, now), null, 'same code twice');
});

test('weak passwords are refused', () => {
  assert.match(passwordProblem('short')!, /10 characters/);
  assert.match(passwordProblem('Password123!')!, /too easy/);
  assert.match(passwordProblem('1111111111')!, /too easy/);
  assert.match(passwordProblem('maryjane-2026-x', 'maryjane@example.com')!, /email/);
  assert.equal(passwordProblem('violet tram kettle'), null);
});

test('every response carries the security headers and API answers are never cached', async () => {
  const r = await call('GET', '/api/public/config');
  assert.equal(r.statusCode, 200);
  assert.match(String(r.headers['content-security-policy']), /default-src 'self'.*frame-ancestors 'none'/);
  assert.equal(r.headers['strict-transport-security'], 'max-age=31536000');
  assert.equal(r.headers['x-frame-options'], 'DENY');
  assert.equal(r.headers['x-content-type-options'], 'nosniff');
  assert.match(String(r.headers['permissions-policy']), /camera=\(self\)/);
  assert.equal(r.headers['cache-control'], 'no-store');
});

test('requests from another website are blocked, same-site requests and machine callers are not', async () => {
  let r = await call('POST', '/api/staff/logout', { cookie: owner, body: {}, headers: { origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' } });
  assert.equal(r.statusCode, 403);
  r = await call('POST', '/api/auth/otp', { body: { email: 'x@example.com' }, headers: { origin: 'https://evil.example' } });
  assert.equal(r.statusCode, 403);
  r = await call('PATCH', '/api/admin/program', { cookie: owner, body: { name: 'Hacked' }, headers: { origin: 'null' } });
  assert.equal(r.statusCode, 403);
  r = await call('GET', '/api/staff/me', { cookie: owner, headers: { origin: 'https://evil.example' } });
  assert.equal(r.statusCode, 200, 'reads are not changed');
  r = await call('PATCH', '/api/admin/program', {
    cookie: owner,
    body: { name: 'Donut Club' },
    headers: { origin: 'https://loyalty.example.com', 'sec-fetch-site': 'same-origin' },
  });
  assert.equal(r.statusCode, 200, r.body);
  r = await call('POST', '/api/pos/v1/stamps', { body: {}, headers: { origin: 'https://pos.example' } });
  assert.equal(r.statusCode, 401, 'POS API answers with its own key check');
});

test('five wrong passwords lock the account; the owner can unlock it', async () => {
  let r = await call('POST', '/api/admin/staff', { cookie: owner, body: { email: 'kim@example.com', name: 'Kim', role: 'staff', password: 'Password123!' } });
  assert.equal(r.statusCode, 400, 'weak password refused');
  r = await call('POST', '/api/admin/staff', { cookie: owner, body: { email: 'kim@example.com', name: 'Kim', role: 'staff', password: 'lantern pebble orbit' } });
  assert.equal(r.statusCode, 200, r.body);
  const kimId = r.json().id;
  for (let i = 0; i < 5; i++) assert.equal((await login('kim@example.com', 'nope nope nope')).statusCode, 401);
  r = await login('kim@example.com', 'lantern pebble orbit');
  assert.equal(r.statusCode, 429);
  assert.match(r.json().error, /locked for 15 more minutes/);
  const staff = (await call('GET', '/api/admin/staff', { cookie: owner })).json();
  assert.equal(staff.find((s: any) => s.id === kimId).locked, true);
  r = await call('PATCH', `/api/admin/staff/${kimId}`, { cookie: owner, body: { unlock: true } });
  assert.equal(r.statusCode, 200);
  assert.equal((await login('kim@example.com', 'lantern pebble orbit')).statusCode, 200);
  // Unknown emails get the same answer as wrong passwords.
  r = await login('nobody@example.com', 'whatever whatever');
  assert.equal(r.statusCode, 401);
  assert.equal(r.json().error, 'Email or password is incorrect');
});

test('role changes, disabling and password changes take effect on open sessions at once', async () => {
  let r = await call('POST', '/api/admin/staff', { cookie: owner, body: { email: 'lee@example.com', name: 'Lee', role: 'manager', password: 'saffron window delta' } });
  const leeId = r.json().id;
  const lee = cookieOf(await login('lee@example.com', 'saffron window delta'), 'od_s');
  assert.equal((await call('GET', '/api/admin/dashboard', { cookie: lee })).statusCode, 200);
  await call('PATCH', `/api/admin/staff/${leeId}`, { cookie: owner, body: { role: 'staff' } });
  assert.equal((await call('GET', '/api/admin/dashboard', { cookie: lee })).statusCode, 403, 'demotion is immediate');
  assert.equal((await call('GET', '/api/staff/me', { cookie: lee })).json().role, 'staff');

  // Changing your own password signs out your other devices but keeps this one.
  const laptop = cookieOf(await login('lee@example.com', 'saffron window delta'), 'od_s');
  r = await call('POST', '/api/staff/security/password', { cookie: lee, body: { current: 'saffron window delta', next: 'password' } });
  assert.equal(r.statusCode, 400);
  r = await call('POST', '/api/staff/security/password', { cookie: lee, body: { current: 'saffron window delta', next: 'copper meadow tiger' } });
  assert.equal(r.statusCode, 200, r.body);
  const leeNew = cookieOf(r, 'od_s');
  assert.equal((await call('GET', '/api/staff/me', { cookie: laptop })).statusCode, 401, 'other device signed out');
  assert.equal((await call('GET', '/api/staff/me', { cookie: leeNew })).statusCode, 200, 'this device stays in');

  // The owner resetting a password, or disabling the account, ends every session.
  await call('PATCH', `/api/admin/staff/${leeId}`, { cookie: owner, body: { active: false } });
  assert.equal((await call('GET', '/api/staff/me', { cookie: leeNew })).statusCode, 401);
});

test('two-step sign-in: set up, sign in with a code, backup codes work once, owner can require it', async () => {
  const secretOf = async (cookie: string) => (await call('POST', '/api/staff/security/two-step/start', { cookie, body: {} })).json();
  // Requiring it before the owner has it on would lock the owner out.
  let r = await call('PATCH', '/api/admin/security', { cookie: owner, body: { requireTwoStep: true } });
  assert.equal(r.statusCode, 400);

  const { secret, uri } = await secretOf(owner);
  assert.match(uri, /^otpauth:\/\/totp\/.+secret=[A-Z2-7]+&issuer=/);
  r = await call('POST', '/api/staff/security/two-step/confirm', { cookie: owner, body: { code: '123456' } });
  assert.equal(r.statusCode, 400);
  const now = currentStep();
  r = await call('POST', '/api/staff/security/two-step/confirm', { cookie: owner, body: { code: totpAt(secret, now) } });
  assert.equal(r.statusCode, 200, r.body);
  const backup: string[] = r.json().backupCodes;
  assert.equal(backup.length, 8);

  // Password alone is no longer enough.
  r = await login(OWNER.email, OWNER.password);
  assert.equal(r.json().status, 'two_step');
  assert.ok(!r.cookies.find((c) => c.name === 'od_s'), 'no session yet');
  const pending = cookieOf(r, 'od_s2');
  r = await call('POST', '/api/staff/login/two-step', { cookie: pending, body: { code: totpAt(secret, now) } });
  assert.equal(r.statusCode, 400, 'the code used to switch it on cannot be replayed');
  r = await call('POST', '/api/staff/login/two-step', { cookie: pending, body: { code: totpAt(secret, now + 1) } });
  assert.equal(r.statusCode, 200, r.body);
  owner = cookieOf(r, 'od_s');

  // A backup code works once.
  r = await login(OWNER.email, OWNER.password);
  r = await call('POST', '/api/staff/login/two-step', { cookie: cookieOf(r, 'od_s2'), body: { code: backup[0].toLowerCase() } });
  assert.equal(r.statusCode, 200, r.body);
  r = await login(OWNER.email, OWNER.password);
  r = await call('POST', '/api/staff/login/two-step', { cookie: cookieOf(r, 'od_s2'), body: { code: backup[0] } });
  assert.equal(r.statusCode, 400);
  assert.equal((await call('GET', '/api/staff/security', { cookie: owner })).json().backupCodesLeft, 7);

  // With the switch on, a manager without two-step can reach the counter and the Security page but not the admin area.
  r = await call('PATCH', '/api/admin/security', { cookie: owner, body: { requireTwoStep: true } });
  assert.equal(r.statusCode, 200, r.body);
  await call('POST', '/api/admin/staff', { cookie: owner, body: { email: 'max@example.com', name: 'Max', role: 'manager', password: 'harbour violet engine' } });
  const max = cookieOf(await login('max@example.com', 'harbour violet engine'), 'od_s');
  r = await call('GET', '/api/admin/dashboard', { cookie: max });
  assert.equal(r.statusCode, 403);
  assert.equal(r.json().code, 'two_step_required');
  assert.equal((await call('GET', '/api/staff/me', { cookie: max })).json().security.twoStepRequired, true);
  const maxSecret = (await secretOf(max)).secret;
  r = await call('POST', '/api/staff/security/two-step/confirm', { cookie: max, body: { code: totpAt(maxSecret, currentStep()) } });
  assert.equal(r.statusCode, 200);
  assert.equal((await call('GET', '/api/admin/dashboard', { cookie: max })).statusCode, 200);
  r = await call('POST', '/api/staff/security/two-step/disable', { cookie: max, body: { password: 'harbour violet engine' } });
  assert.equal(r.statusCode, 400, 'cannot switch it off while required');
});

test('the activity log records sign-ins and admin changes without their values', async () => {
  await call('POST', '/api/admin/stores', { cookie: owner, body: { name: 'Kowloon Bay', address: 'Kowloon' } });
  await call('GET', '/api/admin/customers.csv', { cookie: owner });
  const log = (await call('GET', '/api/admin/activity-log?limit=200', { cookie: owner })).json();
  const actions = log.map((l: any) => l.action);
  for (const a of ['login.ok', 'login.failed', 'login.locked', 'password.changed', 'two_step.enabled', 'POST stores', 'export customers.csv', 'PATCH staff/:id']) {
    assert.ok(actions.includes(a), `${a} logged`);
  }
  const passwordChange = log.find((l: any) => l.action === 'POST staff');
  assert.deepEqual(passwordChange.details.fields.includes('password'), false);
  const signIns = (await call('GET', '/api/admin/activity-log?kind=sign-in', { cookie: owner })).json();
  assert.ok(signIns.every((l: any) => l.action.startsWith('login.') || l.action === 'logout'));
});

test('a member email address gets at most 10 sign-in codes a day', async () => {
  await db.query(
    `INSERT INTO otp_codes (identity, channel, code_hash, expires_at, created_at)
     SELECT 'flood@example.com', 'email', 'x', now(), now() - interval '1 hour' FROM generate_series(1, 10)`,
  );
  const r = await call('POST', '/api/auth/otp', { body: { email: 'flood@example.com' } });
  assert.equal(r.statusCode, 429);
  assert.match(r.json().error, /today/);
});
