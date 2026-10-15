# Launch plan: O! Donut Club

A phased plan from accounts to a full public launch. Weeks are a guide; Apple and Google approvals and your own design work set the real pace.

## Phase 0: Accounts and decisions (week 1)

| Task | Owner | Notes |
|---|---|---|
| Enrol in the Apple Developer Program as an organisation | You | US$99 a year. Needs a D-U-N-S number for the company; allow several days for verification |
| Create a Google Pay & Wallet Console issuer account | You | Free. Needed only for Android wallet cards |
| Buy or choose a domain, e.g. `club.odonut.hk` | You | |
| Pick an email sender (Resend, Postmark, Amazon SES, or Google Workspace SMTP) | You | Set up SPF/DKIM so codes do not land in spam |
| Pick a server | You | Any Linux VPS with Docker (2 GB RAM is plenty to start) |
| Decide the offer | You | Default: 10 stamps = free classic donut (60 days to use); welcome = free topping (30 days); birthday donut; $5 win-back after 30 days away; friend reward after the friend's first purchase |
| Brand art | Designer | Logo PNG, square icon, stamp-on and stamp-off artwork (see `server/assets/pass/README.md`), card colours |

## Phase 1: Set up and soft test (weeks 2 to 3)

1. Follow `docs/04-apple-google-wallet-setup.md` to create the Pass Type ID certificate, Google issuer and VAPID keys.
2. Deploy: copy `.env.example` to `.env`, fill it in, place secrets in `./secrets`, point DNS at the server, run `docker compose up -d --build`.
3. Sign in at `/staff/login` with the owner account, change its password (Team → Reset password), add staff accounts and the store(s) with coordinates.
4. In **Program & automations** set colours, voucher choices and terms; press **Sync Google Wallet design**.
5. Test on real phones (at least one iPhone and one Android):
   - Sign up, receive the code, add to Wallet, confirm the welcome voucher.
   - Stamp at the counter; the pass should update within seconds and show "You now have 1/10 stamps".
   - Complete a card (temporarily set stamps per card to 2), redeem the reward.
   - Send yourself a message from the member page in admin.
   - Walk past the shop to see the location reminder.
6. Google Wallet starts in demo mode (only test accounts can save). Request publishing access in the Wallet Console once the card looks right.

## Phase 2: Staff training and in-store kit (week 4)

- **Counter flow (under 10 seconds):** "Are you an O! Donut Club member?" → member shows the card → scan → choose the number of qualifying items → Add stamps. If no phone: search by mobile number.
- **Rules to train:** one stamp per qualifying item or order (decide which and print it), never stamp without a purchase, redeem vouchers only by scanning or typing the code, and use "Adjust stamps" (manager) with a reason for corrections.
- **Counter tablet:** any tablet or phone with a camera; open `/staff`, add to home screen, keep it charging.
- **Print:** counter tent card and door sticker with a QR to your domain ("Scan, join in 30 seconds, get a free topping"); a sticker on cups or boxes; a slide on the menu screen.

## Phase 3: Soft launch (weeks 5 to 6)

- Invite regulars and friends (target 100 to 300 members).
- Watch the dashboard daily: wallet add rate (aim for 50%+), stamping errors, staff questions.
- Fix friction: if people skip the wallet step, improve the counter pitch ("it lives in your Apple Wallet, no app needed").

## Phase 4: Public launch (week 7)

- **Launch offer:** double stamps for the first two weeks (manager uses Add 2 stamps), or a launch promo code per channel: `IGLAUNCH`, `XHSLAUNCH`, `FLYER`.
- **Channels:** Instagram and Xiaohongshu posts and stories with the join link; KOL tastings with their own promo codes; an in-store "join now" push at the counter for every customer.
- **Day 1 campaign:** none. Let the welcome voucher and stamps do the work. First broadcast after two weeks.

## Phase 5: Retention calendar (ongoing)

| Cadence | What | Audience |
|---|---|---|
| Automatic | Welcome voucher, stamp updates, reward unlocked, birthday, win-back after 30 days, expiry reminders | Everyone it applies to |
| Every week | "So close!" message | Members within 2 stamps of a reward |
| Every 2 weeks | New flavour or limited drop | All opted-in members |
| Monthly | Birthday-month shout-out, member-only tasting | Birthday month / most active members (tag them) |
| Seasonal | Mid-Autumn, Christmas, Lunar New Year boxes with a voucher | All opted-in members |

Guidelines: at most one or two broadcasts a week; every message should be useful (a reward, a new product, a reminder that saves them something). Members who find messages spammy delete the pass, and you lose the free channel.

## Phase 6: Review (monthly)

Look at the dashboard and decide one change per month:
- **Wallet add rate** below 40%: work on the counter pitch and signage.
- **Redemption rate** below 30%: the reward is not attractive or expiry is too short. Above 80%: the card may be too easy.
- **30-day cohort retention** falling: test a bigger welcome reward or an earlier win-back (21 days).
- **Campaign results:** keep the campaign types with the most redemptions; drop the rest.

## Operations checklist

- **Backups:** daily `docker compose exec db pg_dump -U odonut odonut | gzip > backup-$(date +%F).sql.gz`, copied off the server, kept 30 days. Test a restore once.
- **Certificates:** the Apple Pass Type ID certificate expires. Put the expiry date in your calendar a month ahead; renewing means a new certificate for the same Pass Type ID, so existing passes keep working.
- **Updates:** `git pull && docker compose up -d --build`. Migrations run automatically on start.
- **Uptime:** point an uptime monitor at `https://your-domain/healthz`.
- **Privacy:** publish a privacy policy (what you collect, why, how to opt out or delete) and link it from the sign-up page terms.

## Running costs (estimate)

| Item | Cost |
|---|---|
| Apple Developer Program | US$99 a year |
| VPS | about HK$40 to 150 a month |
| Domain | about HK$100 to 200 a year |
| Email sending | free tiers cover thousands of codes a month |
| Google Wallet, web push, Apple pass pushes | free |

Compare: Juicysuite's base plan is HK$22,500 a year before campaigns or messaging packs.
