# What you need to provide: Apple Wallet, Google Wallet, push and email

The system runs without any of these (members use the web card and codes appear in the server log), but a real launch needs them. Keep every file below out of git; put them in `./secrets/` on the server, readable by the app (`chmod 644` or `chown 1000`).

## 1. Apple Wallet pass (required for iPhone)

You need an **Apple Developer Program** membership (organisation, US$99 a year).

1. **Create a Pass Type ID.** developer.apple.com → Certificates, Identifiers & Profiles → Identifiers → `+` → *Pass Type IDs*. Description "O! Donut Club", identifier e.g. `pass.hk.odonut.loyalty`. This goes in `APPLE_PASS_TYPE_ID`.
2. **Find your Team ID.** developer.apple.com → Account → Membership details. Goes in `APPLE_TEAM_ID`.
3. **Make a private key and signing request** on your own computer:
   ```bash
   openssl req -new -newkey rsa:2048 -nodes \
     -keyout pass-key.pem -out pass.csr \
     -subj "/CN=O! Donut Club/emailAddress=you@odonut.hk"
   ```
   Keep `pass-key.pem` private.
4. **Create the certificate.** Certificates → `+` → *Pass Type ID Certificate* → pick your Pass Type ID → upload `pass.csr` → download `pass.cer`. Convert it:
   ```bash
   openssl x509 -inform DER -in pass.cer -out pass-cert.pem
   ```
5. **Download Apple's intermediate certificate** "Worldwide Developer Relations - G4" from https://www.apple.com/certificateauthority/ and convert it:
   ```bash
   openssl x509 -inform DER -in AppleWWDRCAG4.cer -out wwdr.pem
   ```
6. Put `pass-cert.pem`, `pass-key.pem` and `wwdr.pem` in `./secrets/` and set in `.env`:
   ```
   APPLE_PASS_TYPE_ID=pass.hk.odonut.loyalty
   APPLE_TEAM_ID=ABCDE12345
   APPLE_PASS_CERT_FILE=/secrets/pass-cert.pem
   APPLE_PASS_KEY_FILE=/secrets/pass-key.pem
   APPLE_WWDR_FILE=/secrets/wwdr.pem
   ```
   If your key has a passphrase, also set `APPLE_PASS_KEY_PASSPHRASE`. Instead of files you can pass base64 values in `APPLE_PASS_CERT_B64`, `APPLE_PASS_KEY_B64`, `APPLE_WWDR_B64` (useful on hosting platforms with secret variables).
7. **HTTPS is required.** `PUBLIC_URL` must be `https://` with a valid certificate (Caddy in `docker-compose.yml` does this). Without https the pass still installs but never updates.

The same certificate signs passes and authenticates the pushes that update them; no separate APNs key is needed. Note its expiry date and renew before it lapses.

**Check it works:** sign up on an iPhone in Safari, tap *Add to Apple Wallet*, stamp the card from `/staff`. Within a few seconds the pass updates and the lock screen shows "You now have 1/10 stamps". If not, look at **Program & automations → Integrations** and at the app log (`docker compose logs app`), where Apple's device logs also appear.

## 2. Google Wallet (recommended for Android)

1. Open the **Google Pay & Wallet Console** (pay.google.com/business/console), create a business profile and open *Google Wallet API*. Note the **Issuer ID** → `GOOGLE_ISSUER_ID`.
2. In **Google Cloud Console**, create (or pick) a project, enable the **Google Wallet API**, create a **service account**, and download a **JSON key**. Save it as `./secrets/google-wallet-sa.json` → `GOOGLE_SERVICE_ACCOUNT_FILE=/secrets/google-wallet-sa.json`.
3. Back in the Wallet Console → *Users*, invite the service account's email address with *Developer* access.
4. Restart the app, then in **Admin → Program & automations** press **Sync Google Wallet design**.
5. New issuers are in demo mode: only test users you add in the console can save the card. When it looks right, request publishing access in the console.

## 3. Web push (for members who skip the wallet)

Generate keys once and put both in `.env`:
```bash
docker compose run --rm app node -e "const w=require('web-push');const k=w.generateVAPIDKeys();console.log('VAPID_PUBLIC_KEY='+k.publicKey+'\nVAPID_PRIVATE_KEY='+k.privateKey)"
```
(or `npm run vapid -w server` in a development checkout). Set `VAPID_SUBJECT=mailto:you@odonut.hk`. On iPhone, web push works only after the member adds the site to their home screen (iOS 16.4+); the wallet pass is the main iPhone channel.

## 4. Email for sign-in codes

Any SMTP service works. Example with Resend: `SMTP_HOST=smtp.resend.com`, `SMTP_PORT=465`, `SMTP_USER=resend`, `SMTP_PASS=<API key>`, `SMTP_FROM=O! Donut <club@odonut.hk>`. Add the provider's SPF and DKIM records to your domain so codes reach the inbox.

## 5. Your brand art

Drop optional files into `server/assets/pass/`: `logo.png`, `icon.png`, `stamp-on.png`, `stamp-off.png` (details in that folder's README). Then set colours in **Program & automations**. Every installed pass picks up the change the next time it refreshes.

## Summary: what to send or set

| Item | Where it goes |
|---|---|
| Domain pointed at the server | `DOMAIN`, `PUBLIC_URL` |
| Random secrets | `APP_SECRET`, `POSTGRES_PASSWORD` (`openssl rand -hex 32`) |
| Owner login | `ADMIN_EMAIL`, `ADMIN_PASSWORD` |
| Apple Pass Type ID, Team ID, `pass-cert.pem`, `pass-key.pem`, `wwdr.pem` | `.env` + `./secrets/` |
| Google issuer ID + service account JSON | `.env` + `./secrets/` |
| VAPID keys | `.env` |
| SMTP credentials | `.env` |
| Logo, icon, stamp art, colours | `server/assets/pass/` and the admin |
