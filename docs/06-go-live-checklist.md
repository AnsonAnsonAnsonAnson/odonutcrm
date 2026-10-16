# Go-live checklist

Work down the list. Items marked **(you)** need your accounts; everything else is already built.

## 1. Accounts (you)

- [ ] Apple Developer Program (organisation), Pass Type ID and its certificate (docs/04 §1)
- [ ] Domain, e.g. `club.odonut.hk`
- [ ] Email sending (SMTP) with SPF and DKIM records on the domain (docs/04 §4)
- [ ] A Linux server with Docker (2 GB RAM)
- [ ] Optional: Google Wallet issuer (docs/04 §2), Twilio for SMS sign-in (docs/04 §4b)

## 2. Install

```bash
git clone <your repo> odonut && cd odonut      # or unzip the release
bash scripts/setup-server.sh                    # makes .env with random secrets, checks DNS, starts the stack
```

Then fill in the SMTP and Apple lines of `.env`, put `pass-cert.pem`, `pass-key.pem` and `wwdr.pem` in `./secrets`, and restart:

```bash
docker compose up -d
docker compose exec app node dist/cli/doctor.js --online
```

The **go-live check** lists every problem in plain words (certificate expired or not matching the key, wrong team ID, SMTP login failing, DNS not pointing at the server, no privacy policy…). Fix until it says **Ready to launch**.

## 3. Set up the programme (Admin)

- [ ] Sign in at `/staff/login` with the owner account from the setup script; change the password (Team)
- [ ] Team: one account per staff member
- [ ] Stores: name, address and map coordinates (for the lock-screen reminder near the shop)
- [ ] Program & automations: colours, rewards, terms; **privacy policy** ("Start from a template", fill in the brackets, have it checked)
- [ ] Tiers: names, thresholds and perks
- [ ] Rewards & promos: create launch codes per channel, e.g. `IGLAUNCH`, `XHSLAUNCH`, `FLYER`
- [ ] Launch promotion: double stamps with an end date two weeks after launch
- [ ] Brand art in `server/assets/pass/` (logo, icon, stamp images); restart the app
- [ ] Google Wallet (if used): press **Sync Google Wallet design**, then request publishing access in the Wallet Console

## 4. Test on real phones (one iPhone, one Android)

- [ ] Join from the poster QR; the sign-in code arrives by email within a minute
- [ ] Welcome voucher appears; promo code from the QR is applied
- [ ] Add to Apple Wallet / Google Wallet
- [ ] Stamp at the counter: the wallet card updates and the lock screen says "You now have 1/10 stamps"
- [ ] Complete a card (temporarily set stamps per card to 2), redeem the reward, set it back
- [ ] Send yourself a message from Admin → Members; it reaches the lock screen and the Messages inbox
- [ ] Walk past the shop with the card installed: the location reminder appears
- [ ] Delete the test accounts (member settings → Delete account)

## 5. In store

- [ ] Print kit: A4 poster by the till, table tents, staff cheat sheet behind the counter
- [ ] Train each staff member with docs/05-staff-guide.md
- [ ] Counter tablet on `/staff`, added to the home screen, charging

## 6. Keep it running

- [ ] Uptime monitor on `https://your-domain/healthz`
- [ ] Copy `./backups` off the server (nightly), and test one restore
- [ ] Calendar reminder a month before the Apple certificate expires (the admin also warns 30 days ahead)
- [ ] Re-run the go-live check after any change to `.env`
