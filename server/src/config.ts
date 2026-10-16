import { readFileSync, existsSync } from 'node:fs';
import { z } from 'zod';

const bool = z
  .string()
  .optional()
  .transform((v) => v === 'true' || v === '1');

const schema = z.object({
  NODE_ENV: z.string().default('development'),
  PORT: z.coerce.number().default(8080),
  HOST: z.string().default('0.0.0.0'),
  // Public https origin customers and Apple/Google reach, e.g. https://loyalty.odonut.hk
  PUBLIC_URL: z.string().url().default('http://localhost:8080'),
  DATABASE_URL: z.string().default('postgres://postgres:postgres@localhost:5432/odonut'),
  // Long random string; signs sessions and hashes OTPs.
  APP_SECRET: z.string().min(32, 'APP_SECRET must be at least 32 characters'),
  RUN_JOBS: bool.default(true),
  WEB_DIST: z.string().default('../web/dist'),

  // First owner account, created on boot if no staff exist.
  ADMIN_EMAIL: z.string().optional(),
  ADMIN_PASSWORD: z.string().optional(),

  // Email (OTP + notifications). Without SMTP_HOST, OTP codes are written to the server log (dev only).
  SMTP_HOST: z.string().optional(),
  SMTP_PORT: z.coerce.number().default(587),
  SMTP_USER: z.string().optional(),
  SMTP_PASS: z.string().optional(),
  SMTP_FROM: z.string().optional(),

  // Apple Wallet. Provide either *_FILE paths or base64 *_B64 values.
  APPLE_PASS_TYPE_ID: z.string().optional(),
  APPLE_TEAM_ID: z.string().optional(),
  APPLE_PASS_CERT_FILE: z.string().optional(),
  APPLE_PASS_CERT_B64: z.string().optional(),
  APPLE_PASS_KEY_FILE: z.string().optional(),
  APPLE_PASS_KEY_B64: z.string().optional(),
  APPLE_PASS_KEY_PASSPHRASE: z.string().optional(),
  APPLE_WWDR_FILE: z.string().optional(),
  APPLE_WWDR_B64: z.string().optional(),
  APNS_HOST: z.string().default('https://api.push.apple.com'),

  // Google Wallet
  GOOGLE_ISSUER_ID: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_FILE: z.string().optional(),
  GOOGLE_SERVICE_ACCOUNT_B64: z.string().optional(),
  GOOGLE_CLASS_SUFFIX: z.string().default('odonut_stamp_card'),

  // Web push (VAPID). Generate with `npm run vapid -w server`.
  VAPID_PUBLIC_KEY: z.string().optional(),
  VAPID_PRIVATE_KEY: z.string().optional(),
  VAPID_SUBJECT: z.string().default('mailto:hello@example.com'),

  // SMS sign-in codes (optional). TWILIO_FROM is a phone number or a Messaging Service SID (MG...).
  TWILIO_ACCOUNT_SID: z.string().optional(),
  TWILIO_AUTH_TOKEN: z.string().optional(),
  TWILIO_FROM: z.string().optional(),

  TZ_OFFSET_HOURS: z.coerce.number().default(8),
});

function readSecret(file?: string, b64?: string): Buffer | undefined {
  if (b64) return Buffer.from(b64, 'base64');
  if (!file) return undefined;
  if (!existsSync(file)) throw new Error(`Configured file not found: ${file}`);
  try {
    return readFileSync(file);
  } catch (err: any) {
    // Typical in Docker: secret files owned by root with mode 600, app runs as uid 1000.
    throw new Error(`Cannot read ${file} (${err.code}). Make it readable by the app user, e.g. chmod 644 or chown 1000.`);
  }
}

const EMAIL = /[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/;

/**
 * SMTP_FROM as typed into a hosting dashboard is easy to get slightly wrong (HTML-escaped brackets,
 * a bare address, nothing at all). Normalise it to `Name <address>`, falling back to SMTP_USER.
 */
export function senderAddress(from: string | undefined, user: string | undefined): string {
  const raw = (from ?? '').replace(/&lt;/gi, '<').replace(/&gt;/gi, '>').replace(/&amp;/gi, '&').trim().replace(/^["']|["']$/g, '');
  const address = EMAIL.exec(raw)?.[0] ?? EMAIL.exec(user ?? '')?.[0] ?? 'hello@example.com';
  const name = raw.replace(/<[^>]*>/g, '').replace(EMAIL, '').replace(/["<>]/g, '').trim() || 'O! Donut';
  return `${name} <${address}>`;
}

export interface AppleWalletConfig {
  passTypeId: string;
  teamId: string;
  cert: Buffer;
  key: Buffer;
  keyPassphrase?: string;
  wwdr: Buffer;
  apnsHost: string;
}

export type Config = ReturnType<typeof loadConfig>;

export function loadConfig(env: NodeJS.ProcessEnv = process.env) {
  // On Netlify, fall back to the site's own URL and the Netlify DB (Neon) connection string.
  if (env.NETLIFY) env = { ...env, PUBLIC_URL: env.PUBLIC_URL || env.URL, DATABASE_URL: env.DATABASE_URL || env.NETLIFY_DB_URL || env.NETLIFY_DATABASE_URL };
  const parsed = schema.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('\n');
    throw new Error(`Invalid configuration:\n${msg}`);
  }
  const c = parsed.data;
  // Certificate files are only read once the matching IDs are filled in, so the file paths in
  // .env.example do not stop the app starting before the certificates exist.
  const appleOn = !!(c.APPLE_PASS_TYPE_ID && c.APPLE_TEAM_ID);
  const appleCert = appleOn ? readSecret(c.APPLE_PASS_CERT_FILE, c.APPLE_PASS_CERT_B64) : undefined;
  const appleKey = appleOn ? readSecret(c.APPLE_PASS_KEY_FILE, c.APPLE_PASS_KEY_B64) : undefined;
  const wwdr = appleOn ? readSecret(c.APPLE_WWDR_FILE, c.APPLE_WWDR_B64) : undefined;
  const googleSa = c.GOOGLE_ISSUER_ID ? readSecret(c.GOOGLE_SERVICE_ACCOUNT_FILE, c.GOOGLE_SERVICE_ACCOUNT_B64) : undefined;

  const apple: AppleWalletConfig | null =
    c.APPLE_PASS_TYPE_ID && c.APPLE_TEAM_ID && appleCert && appleKey && wwdr
      ? {
          passTypeId: c.APPLE_PASS_TYPE_ID,
          teamId: c.APPLE_TEAM_ID,
          cert: appleCert,
          key: appleKey,
          keyPassphrase: c.APPLE_PASS_KEY_PASSPHRASE,
          wwdr,
          apnsHost: c.APNS_HOST,
        }
      : null;

  let google: null | {
    issuerId: string;
    classId: string;
    clientEmail: string;
    privateKey: string;
  } = null;
  if (c.GOOGLE_ISSUER_ID && googleSa) {
    const sa = JSON.parse(googleSa.toString('utf8'));
    google = {
      issuerId: c.GOOGLE_ISSUER_ID,
      classId: `${c.GOOGLE_ISSUER_ID}.${c.GOOGLE_CLASS_SUFFIX}`,
      clientEmail: sa.client_email,
      privateKey: sa.private_key,
    };
  }

  const vapid =
    c.VAPID_PUBLIC_KEY && c.VAPID_PRIVATE_KEY
      ? { publicKey: c.VAPID_PUBLIC_KEY, privateKey: c.VAPID_PRIVATE_KEY, subject: c.VAPID_SUBJECT }
      : null;

  const smtp = c.SMTP_HOST
    ? { host: c.SMTP_HOST.trim(), port: c.SMTP_PORT, user: c.SMTP_USER?.trim(), pass: c.SMTP_PASS?.replace(/\s+/g, ''), from: senderAddress(c.SMTP_FROM, c.SMTP_USER) }
    : null;

  return {
    env: c.NODE_ENV,
    isProd: c.NODE_ENV === 'production',
    port: c.PORT,
    host: c.HOST,
    publicUrl: c.PUBLIC_URL.replace(/\/$/, ''),
    databaseUrl: c.DATABASE_URL,
    secret: c.APP_SECRET,
    runJobs: c.RUN_JOBS,
    webDist: c.WEB_DIST,
    adminEmail: c.ADMIN_EMAIL,
    adminPassword: c.ADMIN_PASSWORD,
    smtp,
    apple,
    // 'env' when the certificates come from the settings above, 'stored' once the admin setup wizard
    // has activated credentials kept in the database (services/apple/credentials.ts).
    appleSource: (apple ? 'env' : null) as 'env' | 'stored' | null,
    apnsHost: c.APNS_HOST,
    // Tests and offline setups can supply Apple's WWDR intermediate instead of downloading it.
    appleWwdrOverride: c.APPLE_WWDR_B64
      ? Buffer.from(c.APPLE_WWDR_B64, 'base64')
      : c.APPLE_WWDR_FILE && existsSync(c.APPLE_WWDR_FILE)
        ? readSecret(c.APPLE_WWDR_FILE)
        : undefined,
    google,
    vapid,
    tzOffsetHours: c.TZ_OFFSET_HOURS,
    twilio:
      c.TWILIO_ACCOUNT_SID && c.TWILIO_AUTH_TOKEN && c.TWILIO_FROM
        ? { accountSid: c.TWILIO_ACCOUNT_SID, authToken: c.TWILIO_AUTH_TOKEN, from: c.TWILIO_FROM }
        : null,
  };
}
