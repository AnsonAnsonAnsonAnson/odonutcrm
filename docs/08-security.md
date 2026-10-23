# Security: Amazon Lightsail + Cloudflare

This is the security setup for O! Donut Club running on an Amazon Lightsail server (Hong Kong) with Cloudflare in front. Most of it is automatic. The parts you do by hand are numbered steps with the exact buttons to press, about 45 minutes in total, once.

Order matters: do **Part 1** (your accounts) first, then **Part 2** (Cloudflare), **Part 3** (Lightsail) and **Part 4** (the app).

## What protects the club

| Layer | What it does | Who sets it up |
|---|---|---|
| Cloudflare | Hides the server's real address, absorbs floods of fake traffic, blocks known attack patterns, slows down password guessing | You (Part 2), once |
| The server | Only answers Cloudflare. Firewall, SSH by key only, blocks SSH password guessers, installs security updates every night | Automatic (`install.sh`, `update.sh`, `cloudflare.sh`) |
| The containers | The app can't change its own files, runs without admin rights, and the database is never reachable from the internet | Automatic |
| The app | Two-step sign-in, account lockout, strong passwords, an activity log, protection against other websites acting for a signed-in user, strict browser security headers | Automatic; you switch on two-step sign-in (Part 4) |
| Backups | A nightly database copy on the server, plus daily snapshots of the whole server at Amazon | Automatic, plus one switch in Lightsail (Part 3) |

---

## Part 1: Lock your own accounts (10 minutes)

Most break-ins start with someone's email or hosting login, not the website. Turn on two-step sign-in for each of these:

1. **Amazon (AWS)**: sign in at <https://console.aws.amazon.com>. Click your account name at the top right, then **Security credentials**. Under **Multi-factor authentication (MFA)** click **Assign MFA device**, choose **Authenticator app**, and scan the QR code with Google Authenticator, Microsoft Authenticator or the iPhone **Passwords** app.
2. **Cloudflare**: at <https://dash.cloudflare.com> click the person icon at the top right, then **Profile** and the **Authentication** tab. Under **Two-Factor Authentication**, click **Mobile App Authentication** and follow the steps. Save the backup codes it shows.
3. **The Gmail account that sends sign-in codes**: Gmail app passwords only work with 2-Step Verification on, so this is already done. Check it at <https://myaccount.google.com/security>.
4. **Your domain registrar** (where you bought the domain): turn on two-step sign-in and the **registrar lock** (sometimes called "transfer lock").

---

## Part 2: Put Cloudflare in front (20 minutes)

### 2.1 Add your domain to Cloudflare (skip if it's already there)

1. At <https://dash.cloudflare.com> click **Add a domain**, type your main domain (for example `odonut.hk`) and choose the **Free** plan.
2. Cloudflare shows two **nameservers**, like `ada.ns.cloudflare.com`. Sign in to your domain registrar, find **Nameservers** (or DNS servers) for the domain, and replace what's there with Cloudflare's two.
3. Back in Cloudflare, wait until the domain shows **Active** (usually under an hour; Cloudflare emails you).

### 2.2 Point the club address at the server, through Cloudflare

1. In Cloudflare, open your domain and go to **DNS → Records**.
2. Find the record for the club address (for example `club`, type **A**). If there isn't one, click **Add record**: Type **A**, Name `club`, IPv4 address = your Lightsail **static IP**.
3. Make sure **Proxy status** shows the **orange cloud** ("Proxied"). If it's grey, click **Edit**, switch it on, and **Save**.

### 2.3 Encrypt the connection between Cloudflare and the server

1. Go to **SSL/TLS → Overview**. Click **Configure** (or the encryption mode), choose **Full (strict)**, and save.
2. Go to **SSL/TLS → Origin Server** and click **Create Certificate**.
3. Leave everything as it is (RSA, your domain and `*.yourdomain`, **15 years**) and click **Create**.
4. Cloudflare shows two boxes: **Origin Certificate** and **Private Key**. **Leave this page open.** The private key is shown only once.

### 2.4 Install the certificate on the server

1. In Lightsail, open your server and click **Connect using SSH**. A black terminal window opens.
2. Paste this line (use the clipboard icon at the bottom right of the terminal to paste) and press Enter. It brings the server up to date:

   ```
   sudo bash /opt/odonut/scripts/update.sh
   ```

3. Then paste this and press Enter:

   ```
   sudo bash /opt/odonut/scripts/cloudflare.sh
   ```

4. When it asks for the **Origin Certificate**, copy the whole first box in Cloudflare (from `-----BEGIN` to `-----END CERTIFICATE-----`), paste it, and press Enter.
5. When it asks for the **Private Key**, copy the second box and paste it the same way.
6. The script checks everything and prints green ticks:
   - ✓ the site works through Cloudflare
   - ✓ going around Cloudflare to the server's own address gets no answer

   If the first check fails, it offers to undo the change. The usual cause is step 2.3.1 (the mode isn't **Full (strict)** yet) or step 2.2.3 (the cloud is grey).

You can now close the Cloudflare certificate page.

### 2.5 Cloudflare settings

Each of these is one switch. Cloudflare moves menus around now and then; if a name doesn't match, use the search box at the top of the dashboard.

**SSL/TLS → Edge Certificates**
1. **Always Use HTTPS**: On.
2. **Minimum TLS Version**: TLS 1.2.
3. **TLS 1.3**: On.
4. **Automatic HTTPS Rewrites**: On.
5. **HTTP Strict Transport Security (HSTS)**: leave it off here. The club site already sends it for its own address, and switching it on in Cloudflare can affect other sites on your domain.

**Security → WAF**
1. **Managed rules**: check that the **Cloudflare Free Managed Ruleset** is on (it is by default on the Free plan).
2. **Rate limiting rules → Create rule**:
   - Rule name: `Sign-in protection`
   - **If incoming requests match**: click **Edit expression** and paste:

     ```
     (starts_with(http.request.uri.path, "/api/staff/login")) or (starts_with(http.request.uri.path, "/api/auth/"))
     ```

   - **With the same characteristics**: IP
   - **When rate exceeds**: `10` requests per `10 seconds`
   - **Then take action**: Block, for `10 seconds`
   - Click **Deploy**.

   The app has its own, stricter limits too; this stops floods before they reach the server.

**Security → Bots**
1. **Bot Fight Mode**: leave it **off**. It challenges automated visitors, and two automated visitors are friendly: iPhones checking for Apple Wallet card updates, and your till if you use the POS integration. With it on, stamps can stop showing up on wallet cards.

**Caching → Configuration**
1. Leave it as it is. Never add a "Cache Everything" rule for the club address: member pages are personal. (The app also tells Cloudflare never to store them.) The app's own files (scripts, styles, pictures) are marked as safe to keep, so Cloudflare serves them from its Hong Kong servers without you doing anything.

**Speed → Optimization** (names vary a little; use the dashboard search box)
1. **Rocket Loader**: **Off**. It rewrites the page's scripts, which the club site's security rules block, so pages would stay blank.
2. **Brotli** / compression: leave it on (the default).
3. **Network → HTTP/3 (with QUIC)**: On. Faster on phones with patchy signal.
4. **Network → 0-RTT Connection Resumption**: leave it **off**. It saves a few milliseconds but lets a recorded request be replayed.

**DNS → Settings** (optional, recommended)
1. **DNSSEC**: click **Enable DNSSEC**. If your domain isn't registered at Cloudflare, Cloudflare shows a "DS record" to add at your registrar; add it there, or ask the registrar's support to.

### 2.6 If you're ever under attack

If the site is flooded (very slow, or Cloudflare emails you about an attack): in Cloudflare open your domain's **Overview**, and under **Quick Actions** switch on **Under Attack Mode**. Visitors see a 5-second check first. Wallet card updates pause while it's on, so switch it off again when things calm down.

---

## Part 3: Lightsail settings (10 minutes)

### 3.1 Firewall

1. In Lightsail, open your server and go to the **Networking** tab.
2. Under **IPv4 Firewall** you should see exactly three rules: **SSH** (22), **HTTP** (80) and **HTTPS** (443). Delete anything else with the bin icon.
3. If there's an **IPv6 Firewall** section, make it match: SSH, HTTP and HTTPS only.

You don't need to limit the web ports to Cloudflare here: the server itself refuses anyone who isn't Cloudflare (Part 2.4 proved it).

### 3.2 Daily snapshots of the whole server

1. Open your server and go to the **Snapshots** tab.
2. Under **Automatic snapshots**, switch it **on**.
3. Set the time to **20:00 UTC** (that's 04:00 in Hong Kong, when the shop is shut). Lightsail keeps the last 7 days. It costs about US$2 a month.

To go back to a snapshot: **Snapshots** tab, the three dots next to one, **Create new instance**, then move the **static IP** to the new server (**Networking** tab of the new server, **Attach static IP**).

The app also saves a database copy every night into `/opt/odonut/backups` on the server (kept 30 days). Snapshots cover the case where the whole server is lost.

---

## Part 4: In the club admin (5 minutes)

1. Sign in at `https://your-club-address/staff/login`.
2. Open **Security** in the menu.
3. **Two-step sign-in → Turn on two-step sign-in**. Scan the QR code with your authenticator app, type the 6-digit code, then **print or save the 8 backup codes**.
4. **Password**: change it from the one the installer gave you. Three or four unrelated words work well.
5. **Team rules**: tick **Require two-step sign-in for owners and managers**. Managers can still use the counter but must set it up before the admin area opens.
6. Scroll down to the **Activity log** now and then. Every sign-in (and failed attempt) and every change in the admin area is listed with who, when and from where.

Finally, check everything with the go-live check. On the server (Connect using SSH):

```
cd /opt/odonut && sudo docker compose exec app node dist/cli/doctor.js --online
```

The **Security** lines should all show ✓.

---

## When something goes wrong

**Lost your phone, or forgot the owner password.** Use one of your backup codes on the sign-in page (**Lost your phone? Use a backup code**). If you have none left, on the server run:

```
cd /opt/odonut && sudo docker compose exec app node dist/cli/reset-login.js you@youremail.com
```

It prints a new password and switches two-step sign-in off for that account. Sign in, change the password, and turn two-step sign-in back on.

**A team member is locked out.** After 5 wrong passwords in a row an account locks for 15 minutes (longer if it keeps happening). An owner can open **Team** and press **Unlock**, or **Reset password** / **Reset two-step** if they've lost their phone.

**Someone left the shop, or a phone was stolen.** In **Team**, press **Disable** (or **Sign out**). It takes effect immediately, even on a device that's still signed in.

**The site stopped working after the Cloudflare change.** On the server:

```
sudo bash /opt/odonut/scripts/cloudflare.sh --off
```

Then in Cloudflare **DNS → Records**, set the club record to the **grey cloud** (DNS only). The site works directly again while you sort it out.

**Cloudflare changes its addresses** (rare; Cloudflare announces it months ahead). `sudo bash /opt/odonut/scripts/cloudflare.sh --check-ips` tells you if the server's list is out of date; updating the app brings the new list.

---

## For a developer: what's in place

Server-side (Fastify app):
- Staff sign-in: scrypt password hashes; constant work for unknown emails; per-account lockout after 5 failures (15 min, doubling, max 24 h) on top of per-IP rate limits; TOTP two-step sign-in (RFC 6238, ±1 step, replay-protected) with 8 HMAC-hashed single-use backup codes; owner switch to require it for owners and managers (enforced server-side on every admin route).
- Sessions: HS256 JWT in `HttpOnly; Secure; SameSite=Strict` cookies, 12 h; each carries the account's `session_version`, checked on every request against the database together with role, store and active status, so demotion, disabling, password changes and "sign out everywhere" are immediate. Two-step pending state is a separate 5-minute cookie.
- Passwords: minimum 10 characters, common-password and email checks, enforced on create, reset and change.
- CSRF: every cookie-authenticated `POST/PATCH/DELETE` under `/api/` is refused when `Sec-Fetch-Site` is `cross-site`/`same-site` or `Origin` is foreign or `null` (POS API and Apple Wallet web service use their own token auth and are exempt).
- Headers: CSP (`default-src 'self'`, no inline script, `frame-ancestors 'none'`), HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy` (camera self only), COOP, CORP; `Cache-Control: no-store` on all API answers except `/api/public/config` (shop settings only, `private, max-age=30`); `X-Robots-Tag: noindex` on admin, staff, member and API paths.
- Client IP: `trustProxy` limited to loopback and private ranges (the Caddy container), so `X-Forwarded-For` can't be forged to dodge rate limits.
- Rate limits: 600 requests/minute per IP everywhere; tight limits on sign-in, codes and two-step; daily caps on sign-in codes per email (10) and per phone (5).
- Activity log (`audit_log`): sign-ins, failures, lockouts, password and two-step changes, every successful admin change (method, route, target id and changed field names, never values) and CSV exports, with IP and user agent.
- Secrets: TOTP secrets AES-256-GCM encrypted with a key derived from `APP_SECRET`; OTPs HMAC-hashed; API keys SHA-256 hashed.
- Recovery CLI: `dist/cli/reset-login.js`.

Edge and host:
- `caddy/cloudflare.Caddyfile`: Cloudflare Origin CA certificate (Full strict), `abort` for any peer outside Cloudflare's ranges, `CF-Connecting-IP` honoured only from Cloudflare, one clean `X-Forwarded-For` to the app, header/body timeouts, 1 MB body cap, `Server` header removed.
- `docker-compose.yml`: app container `read_only` with tmpfs `/tmp`, `cap_drop: ALL`; Caddy `cap_drop: ALL` + `NET_BIND_SERVICE`; `no-new-privileges` everywhere; Postgres not published; log rotation.
- `scripts/harden-server.sh`: unattended-upgrades with automatic reboot 20:00 UTC, ufw (SSH, 80, 443 only), key-only SSH without root login (only when a key exists), fail2ban for SSH, sysctl network hardening, `.env` 600.
