/**
 * Go-live check. Run on the server after filling in .env:
 *   docker compose exec app node dist/cli/doctor.js          (production)
 *   npm run doctor -w server                                 (development)
 * Add --online to also call Google, Twilio and your public URL.
 */
import { createPrivateKey } from 'node:crypto';
import nodemailer from 'nodemailer';
import { loadConfig } from '../config.js';
import { createPool, one } from '../db.js';
import { checkAppleCert } from '../lib/certs.js';

type Level = 'ok' | 'warn' | 'fail';
const results: { level: Level; area: string; msg: string }[] = [];
const add = (level: Level, area: string, msg: string) => results.push({ level, area, msg });
const online = process.argv.includes('--online');

async function main() {
  let cfg: ReturnType<typeof loadConfig>;
  try {
    cfg = loadConfig();
  } catch (e: any) {
    add('fail', 'Settings', e.message);
    return;
  }
  add('ok', 'Settings', '.env loads');

  // Public address
  if (cfg.publicUrl.startsWith('https://')) add('ok', 'Address', `PUBLIC_URL is ${cfg.publicUrl}`);
  else add(cfg.isProd ? 'fail' : 'warn', 'Address', `PUBLIC_URL is ${cfg.publicUrl}; Apple Wallet updates and secure cookies need https`);
  if (online) {
    try {
      const r = await fetch(`${cfg.publicUrl}/healthz`, { signal: AbortSignal.timeout(8000) });
      add(r.ok ? 'ok' : 'fail', 'Address', `${cfg.publicUrl}/healthz answered ${r.status}`);
    } catch (e: any) {
      add('fail', 'Address', `Could not reach ${cfg.publicUrl}/healthz (${e.cause?.code ?? e.message}). Check DNS and that ports 80 and 443 are open.`);
    }
  }
  if (cfg.secret.length < 32) add('fail', 'Settings', 'APP_SECRET is short; use openssl rand -hex 32');

  // Database
  const db = createPool(cfg.databaseUrl);
  try {
    const m = await one<{ n: number; last: string }>(db, 'SELECT count(*)::int AS n, max(name) AS last FROM schema_migrations');
    add('ok', 'Database', `connected, ${m?.n} migrations applied (latest ${m?.last})`);
    const owner = await one<{ n: number }>(db, `SELECT count(*)::int AS n FROM staff_users WHERE role = 'owner' AND active`);
    if (!owner?.n) add('fail', 'Database', 'No active owner account. Set ADMIN_EMAIL and ADMIN_PASSWORD and restart.');
    const p = await one<{ privacy_policy: string; background_color: string }>(db, 'SELECT privacy_policy, background_color FROM program WHERE id = 1');
    if (!p?.privacy_policy.trim()) add('warn', 'Content', 'No privacy policy yet (Admin → Program & automations)');
    const stores = await one<{ n: number }>(db, 'SELECT count(*)::int AS n FROM stores WHERE active AND latitude IS NOT NULL');
    if (!stores?.n) add('warn', 'Content', 'No store has map coordinates, so the lock-screen reminder near the shop is off (Admin → Stores)');
  } catch (e: any) {
    add('fail', 'Database', `${e.message}. Start the app once so it can migrate, then run this again.`);
  } finally {
    await db.end();
  }

  // Apple Wallet
  if (!cfg.apple) {
    add(cfg.isProd ? 'fail' : 'warn', 'Apple Wallet', 'not set up: APPLE_PASS_TYPE_ID, APPLE_TEAM_ID and the three certificate files are needed (docs/04)');
  } else {
    const s = checkAppleCert(cfg.apple);
    if (s.ok) add('ok', 'Apple Wallet', `certificate valid until ${s.expiresAt?.slice(0, 10)} (${s.daysLeft} days)`);
    for (const p of s.problems) add(p.includes('expires in') ? 'warn' : 'fail', 'Apple Wallet', p);
    if (cfg.apple.apnsHost !== 'https://api.push.apple.com') add('warn', 'Apple Wallet', `APNS_HOST is ${cfg.apple.apnsHost}; production must use https://api.push.apple.com`);
  }

  // Google Wallet
  if (!cfg.google) add('warn', 'Google Wallet', 'not set up (optional; Android members can still use the web card)');
  else {
    try {
      createPrivateKey(cfg.google.privateKey);
      add('ok', 'Google Wallet', `service account ${cfg.google.clientEmail}, class ${cfg.google.classId}`);
    } catch {
      add('fail', 'Google Wallet', 'The service account JSON has no readable private_key');
    }
    if (online) {
      try {
        const { GoogleWallet } = await import('../services/google/wallet.js');
        const gw = new GoogleWallet(cfg.google, cfg.publicUrl, () => {}) as any;
        const token = await gw.accessToken();
        const r = await fetch(`https://walletobjects.googleapis.com/walletobjects/v1/loyaltyClass/${encodeURIComponent(cfg.google.classId)}`, {
          headers: { authorization: `Bearer ${token}` },
        });
        if (r.ok) add('ok', 'Google Wallet', 'API access works and the loyalty class exists');
        else if (r.status === 404) add('warn', 'Google Wallet', 'API access works but the class does not exist yet: press "Sync Google Wallet design" in the admin');
        else add('fail', 'Google Wallet', `API answered ${r.status}; check the service account is added as a user in the Wallet Console`);
      } catch (e: any) {
        add('fail', 'Google Wallet', `Could not get an access token: ${e.message}`);
      }
    }
  }

  // Email
  if (!cfg.smtp) add(cfg.isProd ? 'fail' : 'warn', 'Email', 'SMTP is not set, so members cannot receive sign-in codes');
  else {
    try {
      await nodemailer
        .createTransport({ host: cfg.smtp.host, port: cfg.smtp.port, secure: cfg.smtp.port === 465, auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.pass } : undefined })
        .verify();
      add('ok', 'Email', `signed in to ${cfg.smtp.host}:${cfg.smtp.port}, sending as ${cfg.smtp.from}`);
    } catch (e: any) {
      add('fail', 'Email', `SMTP login to ${cfg.smtp.host} failed: ${e.message}`);
    }
  }

  // Web push and SMS
  add(cfg.vapid ? 'ok' : 'warn', 'Web push', cfg.vapid ? 'VAPID keys set' : 'no VAPID keys (optional; members without the wallet pass get no notifications)');
  if (!cfg.twilio) add('warn', 'SMS', 'Twilio not set (optional; members sign in by email)');
  else if (online) {
    const t = cfg.twilio;
    const r = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${t.accountSid}.json`, {
      headers: { authorization: 'Basic ' + Buffer.from(`${t.accountSid}:${t.authToken}`).toString('base64') },
    }).catch(() => null);
    add(r?.ok ? 'ok' : 'fail', 'SMS', r?.ok ? 'Twilio account reachable' : `Twilio rejected the credentials (${r?.status ?? 'no answer'})`);
  } else add('ok', 'SMS', `Twilio set, sending from ${cfg.twilio.from}`);
}

await main();
const icon = { ok: '✓', warn: '!', fail: '✗' };
for (const r of results) console.log(`${icon[r.level]} ${r.area.padEnd(14)} ${r.msg}`);
const fails = results.filter((r) => r.level === 'fail').length;
const warns = results.filter((r) => r.level === 'warn').length;
console.log(`\n${fails ? `${fails} problem(s) to fix before launch` : 'Ready to launch'}${warns ? `, ${warns} optional item(s)` : ''}.`);
process.exit(fails ? 1 : 0);
