// What leaves the server when it sends an email, and the go-live check of the sender's domain.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from '../src/config.js';
import { buildMessage, senderDomainChecks, textToHtml } from '../src/lib/mailer.js';

const cfg = loadConfig({
  APP_SECRET: 'm'.repeat(40),
  DATABASE_URL: 'postgres://x/y',
  PUBLIC_URL: 'https://club.odonuthk.com',
  SMTP_HOST: 'email-smtp.ap-southeast-2.amazonaws.com',
  SMTP_USER: 'AKIAEXAMPLE',
  SMTP_FROM: 'O! Donut Club <club@odonuthk.com>',
  SMTP_REPLY_TO: 'O! Donut <odonut.shop@gmail.com>',
} as any);

test('every email carries a text and an HTML version, a reply address and auto-reply guards', () => {
  const m = buildMessage(cfg, 'amy@example.com', 'Welcome!', 'Hi Amy,\n\nOpen your card:\nhttps://club.odonuthk.com/m/abc');
  assert.equal(m.from, 'O! Donut Club <club@odonuthk.com>');
  assert.equal(m.replyTo, 'odonut.shop@gmail.com');
  assert.equal(m.headers['Auto-Submitted'], 'auto-generated');
  assert.match(m.text, /Hi Amy/);
  assert.match(m.html, /<p[^>]*>Hi Amy,<\/p>/);
  assert.match(m.html, /<a href="https:\/\/club\.odonuthk\.com\/m\/abc"/);
  assert.match(m.html, /O! Donut Club<\/p>/);
  // A hand-made HTML version wins over the generated one.
  assert.equal(buildMessage(cfg, 'a@b.c', 's', 't', '<b>x</b>').html, '<b>x</b>');
});

test('the HTML version cannot be broken by what a member typed', () => {
  const html = textToHtml('Hi <script>alert(1)</script> & "you"', 'O! Donut');
  assert.doesNotMatch(html, /<script>/);
  assert.match(html, /&lt;script&gt;.*&amp; &quot;you&quot;/);
});

test('the go-live check warns about personal senders and a missing DMARC record', async () => {
  const gmail = await senderDomainChecks('O! Donut <shop@gmail.com>', async () => []);
  assert.equal(gmail.length, 1);
  assert.match(gmail[0].msg, /personal gmail\.com address/);

  const dns: Record<string, string[][]> = {
    '_dmarc.odonuthk.com': [['v=DMARC1; p=none; ', 'rua=mailto:x@odonuthk.com']],
  };
  const lookup = async (n: string) => {
    if (!dns[n]) throw Object.assign(new Error('ENODATA'), { code: 'ENODATA' });
    return dns[n];
  };
  const good = await senderDomainChecks('O! Donut <club@odonuthk.com>', lookup);
  assert.deepEqual(good.map((r) => r.level), ['ok']);
  assert.match(good[0].msg, /p=none/);

  delete dns['_dmarc.odonuthk.com'];
  const noDmarc = await senderDomainChecks('club@odonuthk.com', lookup);
  assert.equal(noDmarc[0].level, 'warn');
});
