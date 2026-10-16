import nodemailer from 'nodemailer';
import type { Config } from '../config.js';

export interface Mailer {
  send(to: string, subject: string, text: string, html?: string): Promise<void>;
}

export function createMailer(cfg: Config, log: (m: string) => void): Mailer {
  if (!cfg.smtp) {
    return {
      async send(to, subject, text) {
        if (cfg.isProd) {
          // Fail loudly: a silently dropped sign-in code looks like a broken site to members.
          log(`[mail disabled] SMTP not configured; could not send "${subject}" to ${to}`);
          throw Object.assign(new Error('Email is not set up: no SMTP_HOST setting'), { code: 'ENOSMTP' });
        }
        log(`[dev mail] to=${to} subject="${subject}"\n${text}`);
      },
    };
  }
  const transport = nodemailer.createTransport({
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.port === 465,
    auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.pass } : undefined,
    // Give up before a serverless function's time limit, so the member sees an error instead of a hang.
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 12_000,
  });
  return {
    async send(to, subject, text, html) {
      await transport.sendMail({ from: cfg.smtp!.from, to, subject, text, html });
    },
  };
}

/** Turns an SMTP failure into a sentence the shop owner can act on. */
export function explainMailError(err: any): string {
  const detail = err?.response ? ` The email server said: "${String(err.response).slice(0, 200)}"` : '';
  switch (err?.code) {
    case 'ENOSMTP':
      return 'Email is not set up yet: the site has no SMTP_HOST setting. Check the setting names in Netlify, then deploy again.';
    case 'EAUTH':
      return `The email server rejected the login in SMTP_USER and SMTP_PASS. For Gmail, SMTP_PASS must be a 16-letter app password, not your normal password.${detail}`;
    case 'ECONNECTION':
    case 'ETIMEDOUT':
    case 'ESOCKET':
    case 'EDNS':
      return `Could not reach the email server in SMTP_HOST and SMTP_PORT (for Gmail: smtp.gmail.com and 587). ${err?.message ?? ''}`.trim();
    case 'EENVELOPE':
      return `The sender in SMTP_FROM or the recipient address was refused.${detail}`;
    default:
      return `Sending failed: ${err?.message ?? 'unknown error'}${detail}`;
  }
}
