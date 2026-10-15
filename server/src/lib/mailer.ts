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
          log(`[mail disabled] SMTP not configured; dropped "${subject}" to ${to}`);
          return;
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
  });
  return {
    async send(to, subject, text, html) {
      await transport.sendMail({ from: cfg.smtp!.from, to, subject, text, html });
    },
  };
}
