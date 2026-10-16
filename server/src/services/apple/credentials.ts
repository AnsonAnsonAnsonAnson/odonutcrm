import { createCipheriv, createDecipheriv, createHash, generateKeyPairSync, randomBytes, X509Certificate, createPrivateKey } from 'node:crypto';
import forge from 'node-forge';
import type { AppleWalletConfig, Config } from '../../config.js';
import { one, type Db } from '../../db.js';
import { HttpError } from '../../lib/auth.js';

/**
 * Apple Wallet setup from the admin dashboard, for hosts where certificate files can't be mounted
 * (Netlify's functions allow only ~4 KB of settings). The owner downloads a signing request made
 * here, uploads it at developer.apple.com, and uploads the certificate Apple returns. The private
 * key never leaves the server and is stored encrypted with a key derived from APP_SECRET.
 */

const WWDR_URL = 'https://www.apple.com/certificateauthority/AppleWWDRCAG4.cer';

interface Row {
  pending_key_enc: string | null;
  pending_csr: string | null;
  pending_created_at: Date | null;
  pass_type_id: string | null;
  team_id: string | null;
  cert_pem: string | null;
  key_enc: string | null;
  wwdr_pem: string | null;
  activated_at: Date | null;
  updated_at: Date;
}

function cipherKey(secret: string): Buffer {
  return createHash('sha256').update(`apple-wallet-key:${secret}`).digest();
}

export function encrypt(secret: string, plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', cipherKey(secret), iv);
  const body = Buffer.concat([c.update(plain, 'utf8'), c.final()]);
  return ['v1', iv.toString('base64'), c.getAuthTag().toString('base64'), body.toString('base64')].join('.');
}

export function decrypt(secret: string, sealed: string): string {
  const [v, iv, tag, body] = sealed.split('.');
  if (v !== 'v1') throw new Error('Unknown key format');
  const d = createDecipheriv('aes-256-gcm', cipherKey(secret), Buffer.from(iv, 'base64'));
  d.setAuthTag(Buffer.from(tag, 'base64'));
  return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
}

function toPem(input: Buffer): string {
  const text = input.toString('utf8');
  if (text.includes('-----BEGIN CERTIFICATE-----')) return text.trim() + '\n';
  return new X509Certificate(input).toString();
}

const field = (subject: string, name: string) => new RegExp(`(?:^|\\n|, )${name}=([^\\n,]+)`).exec(subject)?.[1]?.trim();

async function row(db: Db): Promise<Row | null> {
  return one<Row>(db, 'SELECT * FROM apple_wallet_credentials WHERE id = 1');
}

function toConfig(cfg: Config, r: Row): AppleWalletConfig {
  return {
    passTypeId: r.pass_type_id!,
    teamId: r.team_id!,
    cert: Buffer.from(r.cert_pem!),
    key: Buffer.from(decrypt(cfg.secret, r.key_enc!)),
    wwdr: Buffer.from(r.wwdr_pem!),
    apnsHost: cfg.apnsHost,
  };
}

/** Status for the admin page. */
export async function appleSetupStatus(db: Db, cfg: Config) {
  const r = await row(db);
  return {
    source: cfg.appleSource,
    passTypeId: cfg.apple?.passTypeId ?? null,
    teamId: cfg.apple?.teamId ?? null,
    pendingSince: r?.pending_csr ? r.pending_created_at : null,
    activatedAt: cfg.appleSource === 'stored' ? r?.activated_at ?? null : null,
  };
}

/** Step 1: a new private key and the certificate signing request Apple asks for. */
export async function createSigningRequest(db: Db, cfg: Config, email: string): Promise<string> {
  if (cfg.appleSource === 'env') throw new HttpError(409, 'Apple Wallet is set up with certificate files on the server. Remove them first to use this wizard.');
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keyPem = privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
  const fk = forge.pki.privateKeyFromPem(keyPem) as forge.pki.rsa.PrivateKey;
  const csr = forge.pki.createCertificationRequest();
  csr.publicKey = forge.pki.setRsaPublicKey(fk.n, fk.e);
  csr.setSubject([
    { name: 'commonName', value: 'O! Donut Wallet Pass' },
    { name: 'emailAddress', value: email },
  ]);
  csr.sign(fk, forge.md.sha256.create());
  const csrPem = forge.pki.certificationRequestToPem(csr);
  await db.query(
    `INSERT INTO apple_wallet_credentials (id, pending_key_enc, pending_csr, pending_created_at, updated_at)
     VALUES (1, $1, $2, now(), now())
     ON CONFLICT (id) DO UPDATE SET pending_key_enc = $1, pending_csr = $2, pending_created_at = now(), updated_at = now()`,
    [encrypt(cfg.secret, keyPem), csrPem],
  );
  return csrPem;
}

async function fetchWwdr(): Promise<Buffer> {
  const res = await fetch(WWDR_URL, { signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`apple.com returned ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}

/** Step 2: the certificate Apple issued for that request. Activates Apple Wallet. */
export async function installCertificate(
  db: Db,
  cfg: Config,
  certificate: Buffer,
  getWwdr: () => Promise<Buffer> = fetchWwdr,
): Promise<AppleWalletConfig> {
  if (cfg.appleSource === 'env') throw new HttpError(409, 'Apple Wallet is set up with certificate files on the server.');
  const r = await row(db);
  if (!r?.pending_key_enc) throw new HttpError(409, 'Download a signing request first (step 1), then upload the certificate Apple made from it.');
  let cert: X509Certificate;
  let certPem: string;
  try {
    certPem = toPem(certificate);
    cert = new X509Certificate(certPem);
  } catch {
    throw new HttpError(400, 'That file is not a certificate. Upload the .cer file you downloaded from Apple.');
  }
  const keyPem = decrypt(cfg.secret, r.pending_key_enc);
  if (!cert.checkPrivateKey(createPrivateKey(keyPem))) {
    throw new HttpError(400, 'This certificate was made from a different signing request. Upload the certificate Apple made from the latest request you downloaded here.');
  }
  const passTypeId = field(cert.subject, 'UID');
  const teamId = field(cert.subject, 'OU');
  if (!passTypeId?.startsWith('pass.') || !teamId) {
    throw new HttpError(400, 'This is not a Pass Type ID certificate. In Apple\'s portal, create the certificate from your Pass Type ID.');
  }
  if (new Date(cert.validTo) < new Date()) throw new HttpError(400, 'This certificate has expired. Make a new one at developer.apple.com.');

  let wwdrPem: string;
  try {
    wwdrPem = toPem(cfg.appleWwdrOverride ?? (await getWwdr()));
  } catch (e: any) {
    throw new HttpError(502, `Could not download Apple's intermediate certificate (${e.message}). Try again in a minute.`);
  }
  if (!cert.checkIssued(new X509Certificate(wwdrPem))) {
    throw new HttpError(400, 'This certificate was not issued by Apple Worldwide Developer Relations (G4).');
  }

  await db.query(
    `UPDATE apple_wallet_credentials
        SET pass_type_id = $1, team_id = $2, cert_pem = $3, key_enc = $4, wwdr_pem = $5, activated_at = now(),
            pending_key_enc = NULL, pending_csr = NULL, pending_created_at = NULL, updated_at = now()
      WHERE id = 1`,
    [passTypeId, teamId, certPem, r.pending_key_enc, wwdrPem],
  );
  const apple = toConfig(cfg, (await row(db))!);
  cfg.apple = apple;
  cfg.appleSource = 'stored';
  return apple;
}

/** Turns wizard-made Apple Wallet off again (certificate files in the environment are untouched). */
export async function removeStoredCredentials(db: Db, cfg: Config): Promise<void> {
  await db.query('DELETE FROM apple_wallet_credentials WHERE id = 1');
  if (cfg.appleSource === 'stored') {
    cfg.apple = null;
    cfg.appleSource = null;
  }
}

let lastSync = 0;
let lastSeen: string | null = null;

/**
 * Loads wizard-made credentials into cfg when no certificate files are configured. Serverless hosts
 * run several copies of the app, so they call this with a minimum interval to pick up changes made
 * through another copy. Returns true when cfg.apple changed.
 */
export async function syncStoredCredentials(db: Db, cfg: Config, minIntervalMs = 0): Promise<boolean> {
  if (cfg.appleSource === 'env') return false;
  const now = Date.now();
  if (minIntervalMs && now - lastSync < minIntervalMs) return false;
  lastSync = now;
  const r = await row(db);
  const stamp = r?.cert_pem ? r.updated_at.toISOString() : null;
  if (stamp === lastSeen && (stamp !== null) === (cfg.appleSource === 'stored')) return false;
  lastSeen = stamp;
  let apple: AppleWalletConfig | null = null;
  if (r?.cert_pem && r.key_enc && r.wwdr_pem && r.pass_type_id && r.team_id) {
    try {
      apple = toConfig(cfg, r);
    } catch {
      // Usually APP_SECRET changed since setup. Keep the site running; the owner re-runs the wizard.
      console.error('Apple Wallet credentials could not be unlocked (was APP_SECRET changed?). Set Apple Wallet up again in the admin page.');
    }
  }
  if (apple) {
    cfg.apple = apple;
    cfg.appleSource = 'stored';
  } else {
    cfg.apple = null;
    cfg.appleSource = null;
  }
  return true;
}
