# System plan: O! Donut loyalty CRM

This is the technical design of what is built in this repository: front end, back end, database, wallet passes, stamping, vouchers and push notifications.

## 1. Architecture

```
 Customer phone                     Shop counter (tablet/phone)        Owner laptop
 ┌──────────────────────┐           ┌───────────────────────┐          ┌──────────────┐
 │ Apple / Google Wallet│◀─push─┐   │ /staff  (scan + stamp)│          │ /admin       │
 │  pass (QR, stamps)   │       │   └──────────┬────────────┘          └──────┬───────┘
 │ Member site  /me     │       │              │ HTTPS                        │
 └─────────┬────────────┘       │              ▼                              ▼
           │ HTTPS         ┌────┴───────────────────────────────────────────────────┐
           └──────────────▶│ Caddy (TLS)  ──▶  Node app (Fastify + React build)      │
 Apple Wallet web service ▶│   /api/auth  /api/me  /api/staff  /api/admin            │
 (register, fetch pass)    │   /api/wallet/apple/v1/*  (Apple's spec)                │
                           │   jobs: campaigns, birthdays, win-back, expiry (1/min)  │
                           └───────┬───────────────┬──────────────┬─────────────────┘
                                   ▼               ▼              ▼
                              PostgreSQL     APNs (Apple)    Google Wallet API,
                                             pass pushes     Web Push, SMTP email
```

**One deployable container** serves the API and the web app, plus Postgres and Caddy in `docker-compose.yml`. Background jobs run inside the app process behind a Postgres advisory lock, so you can run several app containers and only one sends.

## 2. Stack

| Layer | Choice | Why |
|---|---|---|
| Language | TypeScript everywhere | One language for API and UI |
| API | Node 22, Fastify 5, Zod validation | Fast, small, typed request validation |
| Database | PostgreSQL 16, plain SQL migrations | Transactions and row locks make stamping safe under load |
| Web | React 19, Vite, React Router | One single-page app with three areas: member, staff, admin |
| Apple Wallet | `passkit-generator` (signing), Node HTTP/2 (APNs) | Proven pass signing; APNs with the pass certificate |
| Pass art | `sharp` renders the stamp strip | Stamp grid image is regenerated per stamp count |
| Google Wallet | REST API with a service account (RS256 JWT) | "Save to Google Wallet" link plus live updates |
| Web push | `web-push` with VAPID | Notifications for members who skip the wallet |
| Email | SMTP via `nodemailer` | Sign-in codes; any provider works |
| Hosting | Docker Compose + Caddy (automatic HTTPS) | Runs on any VPS (e.g. a HK$40 to 80 a month instance) |

## 3. Data model

| Table | Purpose |
|---|---|
| `program` | Single row of settings: stamps per card, colours, reward and automation vouchers, anti-fraud limits, terms |
| `customers` | Member profile, marketing consent, referral code, visit counters, tags, notes |
| `cards` | One per member: `serial_number` + `auth_token` (Apple), `qr_token` (what staff scan), current stamps, lifetime stamps, latest lock-screen message |
| `stamp_events` | Append-only ledger of every stamp, bonus, adjustment and card completion, with staff, store and idempotency key |
| `voucher_templates` | Reward types (free donut, $5 off…) with validity in days |
| `vouchers` | Issued vouchers with unique code, source (welcome, stamp reward, birthday, win-back, promo, referral, campaign, manual), expiry, redemption audit |
| `promo_codes` | Codes members type in; limits, dates, usage counts |
| `campaigns` | Broadcasts: message, segment, optional voucher, schedule, recipients |
| `notifications` | Every message sent to a member and the channels that reached them |
| `apple_devices`, `apple_registrations`, `apple_logs` | Apple Wallet web service state |
| `web_push_subscriptions` | Browser push endpoints |
| `staff_users`, `stores` | Team with roles (owner, manager, staff) and shop locations |
| `tiers` | Membership levels (default Sprinkle 0, Glazed 20, Golden 50 stamps in 365 days), perks, colour and a one-time upgrade voucher |
| `api_keys` | POS keys (only a SHA-256 hash is stored), optional store, last used, revoked |
| `otp_codes`, `job_runs` | Hashed sign-in codes (email or SMS); once-a-day job bookkeeping |

Schema: `server/migrations/001_init.sql` and `002_suite.sql`.

## 4. Key flows

### Sign up (mirrors Wanpo)
1. `POST /api/auth/otp` emails a 6-digit code (stored as an HMAC, 10-minute expiry, 5 attempts, rate limited).
2. `POST /api/auth/verify`: existing member → signed in. New → short-lived sign-up cookie.
3. `POST /api/auth/signup`: creates customer + card + welcome voucher in one transaction. Records the referrer if a code was used.
4. The app shows the reward pop-up and the "One more step left!" wallet page. On desktop it shows a QR containing a 15-minute hand-off link so the phone opens already signed in.

### Add to wallet
- **Apple:** `GET /api/wallet/apple/pass` builds and signs a `.pkpass` (storeCard with stamp strip, member name, rewards count, last update, QR, Member Center link, store locations). Safari opens it in Wallet.
- **Google:** `GET /api/wallet/google/save` redirects to a signed "Save to Google Wallet" link containing the loyalty class and object.

### Stamping at the counter
1. Staff scan the QR on the pass or the web card (`POST /api/staff/scan`), or look the member up by phone or email.
2. `POST /api/staff/stamp` locks the card row, checks the per-scan cap and the cooldown, writes the ledger, rolls over full cards into reward vouchers, updates visit counters, and rewards the referrer on the friend's first purchase. A random idempotency key from the tablet stops double taps or retries from double stamping.
3. After commit, the app pushes the change: APNs to every device holding the pass, a Google Wallet object update, and a "Reward unlocked!" message when a card completes.

### How a pass update reaches the phone (Apple)
1. The card's `updated_at` changes; the server sends an empty push to each registered device via APNs using the Pass Type ID certificate.
2. The phone calls `GET /v1/devices/{device}/registrations/{passType}?passesUpdatedSince=…`, receives the changed serial numbers, then `GET /v1/passes/{passType}/{serial}` for the new pass.
3. iOS compares old and new field values. Fields with a `changeMessage` (stamps, rewards, the news message) show that text on the lock screen.

### Membership tiers
- A member's tier is set by their purchase and bonus stamps in a rolling window (default 365 days). It is re-checked on every stamp (upgrades are instant) and once a day (members who stop visiting move down).
- Reaching a tier for the first time issues its upgrade voucher once (unique index on voucher source), sends "Welcome to Glazed!" to the lock screen, and adds a TIER field to the pass header.
- Admin → Tiers edits levels; campaigns can target one tier.

### Launch promotions
Program settings hold a stamp multiplier (2× or 3×) with an optional start and end. While it runs, each purchase stamp (counter or POS) writes a second `bonus` ledger row, so reports can tell real visits from promotion stamps. Adjustments are never multiplied. The member page, sign-up page and counter screen show the promotion.

### SMS sign-in (optional)
With Twilio configured, existing members can sign in with their mobile number instead of email. Codes go only to numbers that already belong to a member (stops SMS pumping), at most 5 a day and one per 45 seconds. New members still sign up with email.

### POS integration
Admin → POS integration creates an API key (shown once, stored hashed). The till sends `Authorization: Bearer odk_…`:

| Call | What it does |
|---|---|
| `GET /api/pos/v1/members/lookup?phone=91234567` (or `qrToken`, `email`, `memberId`) | Member, stamps, tier and active vouchers. Phone matches on the last 8 digits; 409 if two members share it |
| `POST /api/pos/v1/stamps` `{"member":{"phone":"91234567"},"orderId":"A1001","count":1}` | Adds purchase stamps. The same `orderId` never stamps twice (`duplicate: true`), so retries are safe. Returns stamps, rewards issued and tier |
| `GET /api/pos/v1/vouchers/{code}` | Voucher status, title, kind and value |
| `POST /api/pos/v1/vouchers/redeem` `{"code":"…"}` | Redeems; the audit row records the API key and store |

Stamp rules (per-scan cap, cooldown) apply exactly as at the counter. Revoking a key stops it at once.

### Campaigns and automations
- Campaign send: select the segment → optionally issue a voucher to each recipient (once per campaign, enforced by a unique index) → set the card's news message → push wallets and web push → log.
- Daily at 10:00 HK time: birthday vouchers (once a year), win-back for members lapsed N days (once per lapse), an "almost there" nudge for members 1 to 2 stamps from a reward who have not visited for a week (once per lapse), tier review, voucher expiry, expiry reminders, clean-up.
- Sign-up sends a welcome email with a link back to the Member Center (can be switched off).
- Scheduled campaigns are checked every minute.

### Redeeming a voucher
Member shows the voucher QR in the Member Center. Staff scan it and tap Redeem. The voucher row is locked, checked for status and expiry, marked redeemed with staff and store, and the pass refreshes its rewards count.

## 5. API summary

| Area | Endpoints |
|---|---|
| Public | `GET /api/public/config`, `GET /healthz` |
| Member auth | `POST /api/auth/otp`, `/verify` (email, or phone when SMS is on), `/signup`, `/logout`; `GET /api/auth/card-login` (pass link), `/handoff` (desktop QR) |
| Member | `GET/PATCH/DELETE /api/me`, `GET /api/me/vouchers`, `/history`, `/notifications`, `/handoff`; `POST /api/me/promo`, `/push-subscription` |
| Wallet | `GET /api/wallet/apple/pass`, `/google/save`, `/assets/strip/{n}-{total}.png`, `/assets/logo-square.png` |
| Apple web service | `POST/DELETE /api/wallet/apple/v1/devices/…/registrations/…/{serial}`, `GET …/registrations/{passType}`, `GET /v1/passes/{passType}/{serial}`, `POST /v1/log` |
| Staff | `POST /api/staff/login`, `/logout`, `/scan`, `/stamp`, `/redeem`; `GET /api/staff/me`, `/lookup`, `/activity` |
| Admin | dashboard; customers (list, CSV, detail, tags/notes, stamp adjust, gift voucher, message, delete); voucher templates; promo codes; campaigns (preview, create, send, cancel); program settings; Google class sync; tiers; API keys; stores; staff |
| POS | `GET /api/pos/v1/members/lookup`, `POST /stamps`, `GET /vouchers/{code}`, `POST /vouchers/redeem` (Bearer API key) |

## 6. Security and privacy

- **No passwords for members.** Email codes are HMAC-hashed, single use, expire in 10 minutes, and are rate limited per IP and per email.
- **Sessions** are signed JWTs in `HttpOnly`, `SameSite=Lax` cookies, `Secure` when served over HTTPS. Staff sessions last 12 hours.
- **Staff passwords** use scrypt. Roles: staff (stamp and redeem), manager (plus members and dashboard), owner (plus settings, campaigns, team, export, delete).
- **Apple web service** authenticates every call with the per-pass `ApplePass` token (constant-time compare).
- **Stamp fraud controls:** per-scan cap, cooldown between purchase stamps, idempotency keys, an append-only ledger with staff and store on every row, and referrer rewards only after the friend's first purchase.
- **PDPO:** explicit marketing consent at sign-up (campaigns default to opted-in members only), members can switch it off or delete their account themselves, and owners can export or delete member data. The QR on the pass is a random token, not personal data.
- **Secrets** come only from environment variables or mounted files. Nothing secret is in the repository.

## 7. Scaling and operations

- A single small VPS handles thousands of members: stamping is one short transaction; pass images are cached in memory.
- Multiple app containers are safe: jobs use an advisory lock; migrations use a transaction lock.
- **Backups:** the `backup` service in docker-compose writes a gzipped `pg_dump` to `./backups` every 24 hours and deletes files older than 30 days. Copy that folder off the server as well.
- **Monitoring:** `GET /healthz` for uptime checks; Apple device errors land in `apple_logs` and the app log.
- **Go-live check:** `node dist/cli/doctor.js [--online]` inside the app container checks settings, database, Apple certificate (expiry, key match, team, issuing CA), Google service account, SMTP login, Twilio, DNS and https. The admin Integrations panel shows the certificate expiry and warns 30 days ahead.
- **Wallet files are optional at start-up:** certificate paths are only read once the Apple or Google IDs are set, so the app runs (web card only) before the certificates arrive.

## 8. Testing

`npm test` runs end-to-end API tests against a real Postgres (21 scenarios): sign-up and OTP rules, stamping with cooldown, cap and idempotency, card completion and rollover, redemption, promo codes, referral, signed `.pkpass` contents and signature verification, the full Apple web service cycle including push and `304 Not Modified`, campaigns, birthday, win-back and expiry automations, dashboard, roles, CSV export and account deletion, plus tiers (upgrade, voucher once, pass header, downgrade), SMS sign-in limits, the POS API (keys, order idempotency, redemption audit, revocation), the near-reward nudge, the privacy page, the APNs client against a local HTTP/2 TLS mock, and the Google Wallet client with a mocked API.

## 9. What is intentionally left for later

- **WhatsApp messages** (needs a WhatsApp Business provider such as 360dialog and template approval; per-message cost).
- **Points** (spend-based) in addition to stamps and tiers. Tiers cover the "status" part; points only make sense if prices vary a lot.
- **Native app:** not needed; the wallet pass plus web app covers the same jobs.
