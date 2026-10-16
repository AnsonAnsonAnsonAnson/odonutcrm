# O! Donut Club: loyalty CRM with wallet stamp cards

A self-hosted loyalty system in the style of Wanpo's Juicysuite member club: customers sign up with an email code, get a digital stamp card in Apple Wallet or Google Wallet, collect stamps at the counter, earn vouchers, and receive lock-screen messages. The shop gets a staff scanning screen and an admin dashboard with campaigns, automations and retention analytics.

| | |
|---|---|
| **Member site** `/` and `/me` | Email code sign-in (SMS optional), sign-up with welcome reward and welcome email, add-to-wallet page, stamp card, tier and progress, vouchers with QR, promo codes (also from a poster link), history, messages inbox, refer a friend, notifications, privacy page, EN / 繁中 |
| **Staff counter** `/staff` | Camera QR scanner (or phone/email lookup), member tier, add stamps, redeem vouchers, last 24 hours of activity |
| **Admin** `/admin` | Dashboard (members, active, repeat rate, redemptions, cohorts, card progress), members CRM, campaigns with segments and scheduling, vouchers and promo codes, automations (welcome, birthday, win-back, almost-there nudge, referral, expiry reminders), membership tiers, POS API keys, print kit (counter poster, table tent, staff cheat sheet), double-stamp launch promotions, Apple certificate expiry warnings, privacy policy with a starter template, stores, team roles |
| **POS API** `/api/pos/v1` | Your till stamps cards per paid order (safe retries), looks up members by phone and redeems vouchers |
| **Wallet** | Signed Apple `.pkpass` with a live stamp strip, Apple Wallet web service + APNs updates, Google Wallet loyalty cards, web push |

## Documents

1. [Research: how Wanpo and Juicysuite retain customers](docs/01-research.md)
2. [System plan: architecture, data model, flows, security](docs/02-system-plan.md)
3. [Launch plan: phases, staff training, marketing calendar, operations](docs/03-launch-plan.md)
4. [What you need to provide: Apple, Google, push, email](docs/04-apple-google-wallet-setup.md)
5. [Staff guide: running the club at the counter](docs/05-staff-guide.md)
6. [Go-live checklist](docs/06-go-live-checklist.md)

## Deploy (production)

Requirements: a Linux server with Docker, a domain pointing at it.

```bash
bash scripts/setup-server.sh    # creates .env with random secrets and push keys, checks DNS, starts the stack
# then add SMTP_* and APPLE_* to .env, put pass-cert.pem, pass-key.pem, wwdr.pem in ./secrets (chmod 644)
docker compose up -d
docker compose exec app node dist/cli/doctor.js --online   # go-live check: lists anything still wrong
```

Prefer to do it by hand? `cp .env.example .env`, fill it in, `docker compose up -d --build`.

The stack runs Postgres, the app, Caddy and a nightly backup to `./backups` (30 days kept). Caddy obtains the HTTPS certificate automatically. The app migrates the database and creates the owner account on first start. Open `https://your-domain/staff/login` to sign in.

## Develop locally

Requirements: Node 20+, PostgreSQL.

```bash
npm install
createdb odonut
export APP_SECRET=$(openssl rand -hex 32) DATABASE_URL=postgres://localhost/odonut \
       ADMIN_EMAIL=owner@example.com ADMIN_PASSWORD=change-me-please
npm run dev            # API on :8080, web on :5173 (proxying /api)
```

Without SMTP, sign-in codes print in the API log. To try the Apple pass flow without real certificates: `npm run make-test-certs -w server -- ./certs-test` and point the `APPLE_*` variables at those files (the pass downloads and verifies, but iPhones only accept passes signed with your real certificate).

## Test

```bash
createdb odonut_test
bash server/scripts/make-test-certs.sh /tmp/odcerts
TEST_DATABASE_URL=postgres://localhost/odonut_test TEST_CERT_DIR=/tmp/odcerts npm test
```

25 end-to-end scenarios cover sign-up, stamping rules, rewards, redemption, promo codes, referrals, signed pass contents, the Apple Wallet web service with push, campaigns, automations, roles and data deletion, plus tiers, SMS sign-in, the POS API, the near-reward nudge, the APNs client (against a local HTTP/2 TLS mock), the Google Wallet client (mocked API), double-stamp windows, the Apple certificate checks and the go-live check. `.github/workflows/ci.yml` runs the same on GitHub once the code is pushed there.

## Layout

```
server/            Fastify API (TypeScript)
  migrations/      SQL schema
  src/routes/      customer, staff, admin, wallet, Apple web service, POS
  src/services/    loyalty rules, campaigns, jobs, analytics, notify, apple/, google/
  assets/pass/     optional brand art for the pass
  test/            end-to-end tests
web/               React app (member, staff, admin)
docs/              research, plan, launch, setup
Dockerfile, docker-compose.yml, Caddyfile, .env.example
```

## Default programme (change in Admin → Program & automations)

- 10 stamps → **Free Donut** (valid 60 days)
- Sign-up → **Free Topping** (30 days)
- Birthday → **Birthday Donut** (30 days)
- No visit for 30 days → **$5 Cash Voucher** (14 days), once per lapse, opted-in members only
- Friend's first purchase → **Friend Reward: Free Donut** for the referrer
- Promo code `HELLODONUT` → Free Topping (500 uses)
- Max 5 stamps per scan, 60 seconds between purchase stamps
- Tiers (stamps in the last 365 days): **Sprinkle** 0, **Glazed** 20 (Glazed Member Treat), **Golden** 50 (Golden Member Box)
- 1 to 2 stamps from a reward and no visit for 7 days → "almost there" nudge
