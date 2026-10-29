# Keeping club emails out of junk

The club sends two kinds of email: 6-digit sign-in codes and the welcome email. Both are
"transactional" (a member asked for them), so they should land in the inbox every time.

## Why they go to junk today

The server signs in to a personal Gmail account and sends from it. Gmail, Outlook and Yahoo
see a personal address sending automatic emails with links to another website
(club.odonuthk.com), and many of them file that as junk. Since 2024 Gmail and Yahoo (and
Outlook since May 2025) also expect businesses to send from their own domain with three DNS
records that prove the email is genuine:

| Record | What it proves |
|---|---|
| **SPF** | This email service is allowed to send for odonuthk.com |
| **DKIM** | The email was signed by odonuthk.com and not changed on the way |
| **DMARC** | What odonuthk.com wants done with emails that fail the two checks above |

## The fix

1. Send from an address on your own domain, such as `club@odonuthk.com`, through an email
   service built for this (Resend, recommended below; Amazon SES and Google Workspace work too).
2. Add that service's SPF and DKIM records, plus a DMARC record, in Cloudflare.
3. The app already does the rest (since this change): every email has a plain-text and an
   HTML version, a reply-to address, auto-reply guards, and links only to your own domain.
   The go-live check (`doctor`) warns when the sender is a personal address or DMARC is missing.

## Step by step with Resend

Resend is free for 100 emails a day (3,000 a month). Each new member gets two emails (code +
welcome), so that covers about 50 sign-ups a day. For a busy launch week, switch to the Pro
plan (US$20 a month) and back afterwards, or turn the welcome email off for a few days.

### A. Create the Resend account and add your domain
1. Go to https://resend.com and press **Get started**. Sign up with the shop's Google account.
2. In the left menu press **Domains**, then **Add domain**.
3. Type `odonuthk.com`. For **Region** choose **Tokyo (ap-northeast-1)**, the closest to
   Hong Kong. Press **Add**.
4. Resend shows a short list of DNS records. If it offers **Auto configure** with Cloudflare,
   press it, sign in to Cloudflare and approve; then skip to step C. Otherwise keep this page
   open and do step B.

### B. Add the records in Cloudflare (by hand)
1. In a new tab open https://dash.cloudflare.com, choose **odonuthk.com**, then **DNS → Records**.
2. For each record Resend lists, press **Add record** and copy across:
   - **Type** (MX or TXT), **Name** (for example `send` or `resend._domainkey`), and
     **Content / Value** (use the copy button in Resend so nothing is missed).
   - For the MX record also fill **Priority** with the number Resend shows (usually 10).
3. Press **Save** after each one. Leave the "A" record for `club` exactly as it is.

### C. Turn on DMARC in Cloudflare (free, with reports)
1. In Cloudflare, still on odonuthk.com, open **Email → DMARC Management** and press
   **Enable DMARC Management**. Cloudflare adds a `_dmarc` record that starts in
   "monitor only" mode (`p=none`) and collects reports for you.
2. After two to four weeks, if the DMARC Management page shows Resend passing and nothing
   unknown sending as you, edit the `_dmarc` record and change `p=none` to `p=quarantine`.
   That stops others from faking your address.

### D. Verify the domain and make a key
1. Back in Resend press **Verify DNS records**. It can take from a few minutes up to an hour;
   wait until every line says **Verified**.
2. In the left menu press **API Keys → Create API key**. Name it `O! Donut server`,
   permission **Sending access**, domain **odonuthk.com**. Press **Add** and copy the key
   (it starts with `re_`). Resend shows it only once.

### E. Tell the server
1. Open the Lightsail console and connect to the server (the orange **>_** button).
2. Get the latest version: type `sudo bash /opt/odonut/scripts/update.sh` and press Enter.
3. Then type `sudo bash /opt/odonut/scripts/email.sh` and answer:
   - Service: `1` (Resend)
   - API key: paste the `re_...` key
   - Send from: `club@odonuthk.com`
   - Sender name: press Enter for "O! Donut Club"
   - Inbox for replies: the Gmail address you read every day
4. The script restarts the app and runs the go-live check. The **Email** lines should say it
   signed in to smtp.resend.com and that odonuthk.com has a DMARC record.

### F. Check it really lands in the inbox
1. In the admin open **Program & automations → Send a test email**.
2. In Gmail open the email, press the three dots **⋮ → Show original**. You should see
   **SPF: PASS**, **DKIM: PASS** and **DMARC: PASS**.
3. For a score out of 10, open https://www.mail-tester.com and copy the address it shows.
   On the club's join page, start joining with that address until it says a code was sent
   (no need to finish). Back on mail-tester press **Then check your score**. 9/10 or more is good.

## Good habits that keep you in the inbox
- Keep the same sender name and address. Changing them often looks suspicious.
- In the first week, if a code or welcome email lands in junk for you or staff, press
  **Not spam**. Early "not spam" clicks teach Gmail and Outlook to trust the new sender.
- Don't use the club address for promotions to people who didn't join; complaints above
  0.3% make Gmail send everything to junk.
- When the server moves to Hong Kong, nothing here changes: the records live in Cloudflare.

## Other services
| Service | Settings in `scripts/email.sh` | Notes |
|---|---|---|
| Amazon SES | Choice 2: region, SMTP username and password from SES → SMTP settings | About US$0.10 per 1,000 emails. New accounts start in a "sandbox" and must request production access. Add the 3 DKIM CNAME records with the cloud **grey** (DNS only). |
| Google Workspace | Choice 3: the Workspace address and an app password | About US$7 a month per user; also gives you a real `@odonuthk.com` mailbox. Turn on DKIM in Google Admin → Apps → Gmail → Authenticate email. Limit 2,000 emails a day. |
| Gmail (personal) | Choice 3 | Works, but the most likely to land in junk. |
