import type { Config } from '../config.js';

export interface SmsSender {
  enabled: boolean;
  send(to: string, body: string): Promise<void>;
}

/** Twilio SMS. Without credentials, development builds log the message and production drops it. */
export function createSms(cfg: Config, log: (m: string) => void): SmsSender {
  const t = cfg.twilio;
  if (!t) {
    return {
      enabled: !cfg.isProd,
      async send(to, body) {
        if (cfg.isProd) throw new Error('SMS is not configured');
        log(`[dev sms] to=${to}\n${body}`);
      },
    };
  }
  return {
    enabled: true,
    async send(to, body) {
      const params = new URLSearchParams({ To: to, Body: body });
      if (t.from.startsWith('MG')) params.set('MessagingServiceSid', t.from);
      else params.set('From', t.from);
      const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${t.accountSid}/Messages.json`, {
        method: 'POST',
        headers: {
          authorization: 'Basic ' + Buffer.from(`${t.accountSid}:${t.authToken}`).toString('base64'),
          'content-type': 'application/x-www-form-urlencoded',
        },
        body: params,
      });
      if (!res.ok) throw new Error(`Twilio ${res.status}: ${await res.text()}`);
    },
  };
}
