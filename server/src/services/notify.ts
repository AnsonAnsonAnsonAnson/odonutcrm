import webpush from 'web-push';
import type { Config } from '../config.js';
import { many, one, type Db } from '../db.js';
import { Apns } from './apple/apns.js';
import { GoogleWallet } from './google/wallet.js';
import { getProgram, loadPassData } from './program.js';

export interface Message {
  kind: string; // reward, stamp, campaign, birthday, winback, expiry, referral, welcome
  title: string;
  body: string;
  campaignId?: string;
  url?: string;
}

export class Notifier {
  apns: Apns | null;
  google: GoogleWallet | null;
  constructor(private db: Db, private cfg: Config, private log: (m: string) => void) {
    this.apns = cfg.apple ? new Apns(cfg.apple, log) : null;
    this.google = cfg.google ? new GoogleWallet(cfg.google, cfg.publicUrl, log) : null;
    if (cfg.vapid) webpush.setVapidDetails(cfg.vapid.subject, cfg.vapid.publicKey, cfg.vapid.privateKey);
  }

  /** Tell every wallet holding this card to refresh (stamp count, reward count, message). */
  async passChanged(customerId: string, googleMessage?: { header: string; body: string }): Promise<string[]> {
    const channels: string[] = [];
    const data = await loadPassData(this.db, { customerId });
    if (!data) return channels;
    if (this.apns && this.cfg.apple) {
      const regs = await many<{ device_library_id: string; push_token: string }>(
        this.db,
        `SELECT d.device_library_id, d.push_token FROM apple_registrations r
           JOIN apple_devices d USING (device_library_id)
          WHERE r.serial_number = $1 AND r.pass_type_id = $2`,
        [data.card.serial_number, this.cfg.apple.passTypeId],
      );
      if (regs.length) {
        const results = await this.apns.send([...new Set(regs.map((r) => r.push_token))]);
        for (const r of results) {
          if (r.status === 410 || r.reason === 'BadDeviceToken' || r.reason === 'Unregistered') {
            await this.db.query('DELETE FROM apple_devices WHERE push_token = $1', [r.token]);
          } else if (r.status !== 200) {
            this.log(`apns ${r.status} ${r.reason ?? ''}`);
          }
        }
        if (results.some((r) => r.status === 200)) channels.push('apple_wallet');
      }
    }
    if (this.google && data.card.google_saved) {
      try {
        const program = await getProgram(this.db);
        if (await this.google.updateObject(program, data, googleMessage)) channels.push('google_wallet');
      } catch (err: any) {
        this.log(`google update failed: ${err.message}`);
      }
    }
    return channels;
  }

  /**
   * Sends a message to one customer on every channel they have: the wallet pass lock-screen
   * message (Apple changeMessage / Google TEXT_AND_NOTIFY) and browser web push.
   */
  async notify(customerId: string, msg: Message): Promise<string[]> {
    const card = await one<{ message: string | null }>(this.db, 'SELECT message FROM cards WHERE customer_id = $1', [customerId]);
    if (!card) return [];
    let text = `${msg.title}: ${msg.body}`;
    // Apple only alerts when the value changes; nudge identical repeats so they still show.
    if (card.message === text) text += '​';
    await this.db.query(
      'UPDATE cards SET message = $2, message_updated_at = now(), updated_at = now() WHERE customer_id = $1',
      [customerId, text],
    );
    const channels = await this.passChanged(customerId, { header: msg.title, body: msg.body });
    channels.push(...(await this.webPush(customerId, msg)));
    await this.db.query(
      `INSERT INTO notifications (customer_id, campaign_id, kind, title, body, channels) VALUES ($1,$2,$3,$4,$5,$6)`,
      [customerId, msg.campaignId ?? null, msg.kind, msg.title, msg.body, channels],
    );
    return channels;
  }

  async webPush(customerId: string, msg: Message): Promise<string[]> {
    if (!this.cfg.vapid) return [];
    const subs = await many<{ id: string; endpoint: string; p256dh: string; auth: string }>(
      this.db,
      'SELECT id, endpoint, p256dh, auth FROM web_push_subscriptions WHERE customer_id = $1',
      [customerId],
    );
    let ok = false;
    for (const s of subs) {
      try {
        await webpush.sendNotification(
          { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
          JSON.stringify({ title: msg.title, body: msg.body, url: msg.url ?? '/me' }),
          { TTL: 24 * 3600 },
        );
        ok = true;
      } catch (err: any) {
        if (err.statusCode === 404 || err.statusCode === 410) {
          await this.db.query('DELETE FROM web_push_subscriptions WHERE id = $1', [s.id]);
        } else {
          this.log(`web push failed: ${err.statusCode ?? ''} ${err.message}`);
        }
      }
    }
    return ok ? ['web_push'] : [];
  }

  close() {
    this.apns?.close();
  }
}
