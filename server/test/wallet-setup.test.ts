// Apple Wallet setup from the admin page: signing request, certificate upload, then a working pass.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import forge from 'node-forge';
import type { FastifyInstance, LightMyRequestResponse } from 'fastify';
import { loadConfig } from '../src/config.js';
import { createPool, migrate, type Db } from '../src/db.js';
import { buildApp } from '../src/app.js';
import { seed } from '../src/seed.js';
import { decrypt, syncStoredCredentials } from '../src/services/apple/credentials.js';

const DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/odonut_test';
const CERTS = process.env.TEST_CERT_DIR ?? '/tmp/claude-0/odcerts';

let app: FastifyInstance;
let db: Db;
let cfg: ReturnType<typeof loadConfig>;
const mail: { to: string; text: string }[] = [];
let owner = '';

const cookieOf = (res: LightMyRequestResponse, name: string) => `${name}=${res.cookies.find((c) => c.name === name)!.value}`;
const call = (method: string, url: string, o: { cookie?: string; body?: unknown } = {}) =>
  app.inject({ method: method as any, url, payload: o.body as any, headers: o.cookie ? { cookie: o.cookie } : {} });

/** Plays Apple's part: issues a Pass Type ID certificate for the request, signed by the test WWDR CA. */
function appleIssues(csrPem: string, passTypeId = 'pass.test.wizard', team = 'WIZTEAM001'): string {
  const csr = forge.pki.certificationRequestFromPem(csrPem);
  assert.ok(csr.verify(), 'signing request is self-signed correctly');
  const ca = forge.pki.certificateFromPem(readFileSync(join(CERTS, 'wwdr.pem'), 'utf8'));
  const caKey = forge.pki.privateKeyFromPem(readFileSync(join(CERTS, 'wwdr.key'), 'utf8'));
  const cert = forge.pki.createCertificate();
  cert.publicKey = csr.publicKey!;
  cert.serialNumber = '0a1b2c';
  cert.validity.notBefore = new Date(Date.now() - 60_000);
  cert.validity.notAfter = new Date(Date.now() + 365 * 86_400_000);
  cert.setSubject([
    { type: '0.9.2342.19200300.100.1.1', value: passTypeId },
    { name: 'commonName', value: `Pass Type ID: ${passTypeId}` },
    { name: 'organizationalUnitName', value: team },
  ]);
  cert.setIssuer(ca.subject.attributes);
  cert.sign(caKey as forge.pki.rsa.PrivateKey, forge.md.sha256.create());
  // Apple hands out DER (.cer), so upload that form.
  return Buffer.from(forge.asn1.toDer(forge.pki.certificateToAsn1(cert)).getBytes(), 'binary').toString('base64');
}

before(async () => {
  db = createPool(DB_URL);
  await db.query('DROP SCHEMA public CASCADE; CREATE SCHEMA public;');
  await migrate(db, () => {});
  await seed(db, { adminEmail: 'owner@example.com', adminPassword: 'correct horse battery', log: () => {} });
  cfg = loadConfig({
    APP_SECRET: 'w'.repeat(40),
    PUBLIC_URL: 'https://loyalty.example.com',
    DATABASE_URL: DB_URL,
    // No certificate files: Apple Wallet starts off. The test WWDR CA stands in for Apple's.
    APPLE_WWDR_FILE: join(CERTS, 'wwdr.pem'),
    WEB_DIST: '/nonexistent',
  } as any);
  app = await buildApp(cfg, db, { logger: false, mailer: { send: async (to, _s, text) => void mail.push({ to, text }) } });
  const r = await call('POST', '/api/staff/login', { body: { email: 'owner@example.com', password: 'correct horse battery' } });
  owner = cookieOf(r, 'od_s');
});

after(async () => {
  await app?.close();
  await db?.end();
});

test('the owner sets up Apple Wallet from the admin page and members get a signed pass', async () => {
  assert.equal(cfg.apple, null);
  let st = (await call('GET', '/api/admin/apple-wallet', { cookie: owner })).json();
  assert.equal(st.source, null);

  // Uploading before a signing request exists is refused.
  let r = await call('POST', '/api/admin/apple-wallet/certificate', { cookie: owner, body: { certificate: 'A'.repeat(200) } });
  assert.equal(r.statusCode, 409);

  r = await call('POST', '/api/admin/apple-wallet/csr', { cookie: owner, body: {} });
  assert.equal(r.statusCode, 200, r.body);
  const { csr } = r.json();
  assert.match(csr, /BEGIN CERTIFICATE REQUEST/);
  const stored = (await db.query('SELECT pending_key_enc FROM apple_wallet_credentials')).rows[0].pending_key_enc;
  assert.doesNotMatch(stored, /PRIVATE KEY/, 'key is stored encrypted');
  assert.match(decrypt(cfg.secret, stored), /BEGIN RSA PRIVATE KEY/);

  // A certificate for some other key is refused with a plain explanation.
  const other = readFileSync(join(CERTS, 'signer.pem')).toString('base64');
  r = await call('POST', '/api/admin/apple-wallet/certificate', { cookie: owner, body: { certificate: other } });
  assert.equal(r.statusCode, 400);
  assert.match(r.json().error, /different signing request/);

  r = await call('POST', '/api/admin/apple-wallet/certificate', { cookie: owner, body: { certificate: appleIssues(csr) } });
  assert.equal(r.statusCode, 200, r.body);
  st = r.json();
  assert.equal(st.source, 'stored');
  assert.equal(st.passTypeId, 'pass.test.wizard');
  assert.equal(st.teamId, 'WIZTEAM001');
  assert.ok(app.svc.notifier.apns, 'wallet push is ready');

  const program = (await call('GET', '/api/admin/program', { cookie: owner })).json();
  assert.equal(program.integrations.appleWallet, true);
  assert.equal(program.integrations.appleCert.ok, true, JSON.stringify(program.integrations.appleCert.problems));

  // A member downloads a signed pass.
  await call('POST', '/api/auth/otp', { body: { email: 'wally@example.com' } });
  const code = mail.at(-1)!.text.match(/\b(\d{6})\b/)![1];
  r = await call('POST', '/api/auth/verify', { body: { email: 'wally@example.com', code } });
  r = await call('POST', '/api/auth/signup', {
    cookie: cookieOf(r, 'od_su'),
    body: { firstName: 'Wally', lastName: 'Et', phone: '+852 6000 7777', birthday: '1991-02-03', gender: 'undisclosed', acceptTerms: true },
  });
  const member = cookieOf(r, 'od_c');
  r = await call('GET', '/api/wallet/apple/pass', { cookie: member });
  assert.equal(r.statusCode, 200, r.body);
  assert.equal(r.headers['content-type'], 'application/vnd.apple.pkpass');
  assert.equal(r.rawPayload.subarray(0, 2).toString(), 'PK');
  assert.ok(r.rawPayload.includes(Buffer.from('signature')), 'pass is signed');

  // Another copy of the app (another serverless instance) picks the credentials up from the database.
  const cfg2 = loadConfig({ APP_SECRET: 'w'.repeat(40), DATABASE_URL: DB_URL, WEB_DIST: '/nonexistent' } as any);
  assert.equal(await syncStoredCredentials(db, cfg2), true);
  assert.equal(cfg2.apple?.passTypeId, 'pass.test.wizard');

  // Turning it off.
  r = await call('DELETE', '/api/admin/apple-wallet', { cookie: owner });
  assert.equal(r.json().source, null);
  assert.equal((await call('GET', '/api/wallet/apple/pass', { cookie: member })).statusCode, 503);
});
