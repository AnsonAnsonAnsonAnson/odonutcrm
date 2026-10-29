import { resolveTxt } from 'node:dns/promises';
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
    // Greet the mail server with the site's real name instead of the container's random hostname.
    name: new URL(cfg.publicUrl).hostname,
    host: cfg.smtp.host,
    port: cfg.smtp.port,
    secure: cfg.smtp.port === 465,
    auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.pass } : undefined,
    // Keep a couple of connections to the mail server open between emails: sign-in codes go out
    // without a fresh login (and TLS handshake) to Gmail every time.
    pool: true,
    maxConnections: 2,
    maxMessages: 100,
    // Give up before a serverless function's time limit, so the member sees an error instead of a hang.
    connectionTimeout: 8_000,
    greetingTimeout: 8_000,
    socketTimeout: 12_000,
  });
  return {
    async send(to, subject, text, html) {
      await transport.sendMail(buildMessage(cfg, to, subject, text, html));
    },
  };
}

/**
 * The full email as handed to the mail server. Spam filters trust mail that looks like a real
 * business sent it: a plain-text and an HTML version of the same words, a reply address, and
 * headers marking it as an automatic message (so out-of-office replies don't bounce back).
 */
export function buildMessage(cfg: Config, to: string, subject: string, text: string, html?: string) {
  const smtp = cfg.smtp!;
  return {
    from: smtp.from,
    to,
    subject,
    text,
    html: html ?? textToHtml(text, smtp.from.replace(/\s*<[^>]*>$/, '')),
    replyTo: smtp.replyTo,
    headers: { 'Auto-Submitted': 'auto-generated', 'X-Auto-Response-Suppress': 'OOF, AutoReply' },
  };
}

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** A plain, image-free HTML version of a text email: paragraphs, clickable links, a small footer. */
export function textToHtml(text: string, sender: string): string {
  const paragraphs = text
    .trim()
    .split(/\n{2,}/)
    .map((p) => {
      const body = escapeHtml(p)
        .replace(/https?:\/\/[^\s<]+/g, (url) => `<a href="${url}" style="color:#004A94">${url}</a>`)
        .replace(/\n/g, '<br>');
      return `<p style="margin:0 0 16px">${body}</p>`;
    })
    .join('\n');
  return `<!doctype html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"></head>
<body style="margin:0;padding:24px 16px;background:#fff8f0;font-family:-apple-system,'Segoe UI',Helvetica,Arial,sans-serif;font-size:16px;line-height:1.5;color:#222">
<div style="max-width:480px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px">
${paragraphs}
<p style="margin:24px 0 0;font-size:13px;color:#777">${escapeHtml(sender)}</p>
</div>
</body></html>`;
}

/** Turns an SMTP failure into a sentence the shop owner can act on. */
export function explainMailError(err: any): string {
  const detail = err?.response ? ` The email server said: "${String(err.response).slice(0, 200)}"` : '';
  switch (err?.code) {
    case 'ENOSMTP':
      return 'Email is not set up yet: the site has no SMTP_HOST setting. Check the setting names in Netlify, then deploy again.';
    case 'EAUTH':
      return `The email server rejected the login in SMTP_USER and SMTP_PASS. For Gmail, SMTP_PASS must be a 16-letter app password, not your normal password. For Resend, SMTP_USER is resend and SMTP_PASS is an API key.${detail}`;
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

const FREE_MAIL = /^(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|icloud|me|qq|163|126|yeah|netvigator)\./i;

/**
 * Gmail and Yahoo expect mail from a shop's own domain to carry a DMARC record. SPF and DKIM
 * records sit under provider-specific names (send.<domain>, resend._domainkey...), so the
 * provider's own dashboard is where those are checked.
 */
export async function senderDomainChecks(from: string, txt: (name: string) => Promise<string[][]> = resolveTxt) {
  const domain = /@([^>\s]+)>?$/.exec(from)?.[1]?.toLowerCase();
  if (!domain) return [];
  if (FREE_MAIL.test(domain)) {
    return [{ level: 'warn' as const, msg: `sending from a personal ${domain} address, so some emails land in junk. Send from an address on your own domain instead: docs/09-email-delivery.md` }];
  }
  const records = (await txt(`_dmarc.${domain}`).catch(() => [] as string[][])).map((r) => r.join(''));
  const dmarc = records.find((r) => /^v=DMARC1\b/i.test(r));
  return [
    dmarc
      ? { level: 'ok' as const, msg: `${domain} has a DMARC record (${/p=\w+/i.exec(dmarc)?.[0] ?? 'no policy'})` }
      : { level: 'warn' as const, msg: `${domain} has no DMARC record, which Gmail and Yahoo expect: docs/09-email-delivery.md` },
  ];
}
