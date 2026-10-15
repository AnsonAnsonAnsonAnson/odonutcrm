# Research: how Wanpo and Juicysuite keep customers coming back

*Prepared 15 October 2026 for the O! Donut loyalty project.*

## 1. What Juicysuite is

Juicysuite is a Hong Kong loyalty and CRM platform for food and beverage and retail brands. Wanpo (萬波), the bubble tea chain, runs its member club on it at `wanpo.juicysuite.app`. It is listed on Cyberport's digital tech supplier list, on the Shopify App Store (launched February 2025, English and Chinese), and as a SleekFlow (WhatsApp CRM) partner.

What it sells, from its Cyberport listing:

| Package | Price (HKD) | What it includes |
|---|---|---|
| Base plan | 22,500 per year | Set-up of the wallet pass loyalty programme plus a 12-month subscription |
| Growth service | 36,000 | Six done-for-you campaigns (buy 1 get 1, double points, giveaways, promo codes) and management of 60 KOLs |
| Engagement messages | 7,000 | A bundle of SMS or WhatsApp messages for OTPs and promotions |
| All three | 65,500 | |

Its feature list: join through web, messenger, app or wallet pass; welcome, birthday and referral rewards; buy-X-get-Y; tiers and tiered points; product-specific and spend-goal rewards; time-limited and re-engagement campaigns; an AI "customer data platform" that segments members; and an operator portal where frontline staff look up members, process orders and redeem rewards. It also integrates with Shopify POS.

**Takeaway for O! Donut:** the system built in this project covers the same core (wallet stamp card, welcome, birthday, referral, win-back, promo codes, campaigns, staff portal, analytics) without the HK$22,500 yearly fee. What you would still pay for is Apple's developer membership (US$99 a year), hosting, and email or SMS sending.

## 2. Teardown of the Wanpo member journey (from your screenshots)

1. **One field to start.** The landing page is a mascot photo with a single "Email" box and a "Next Step" button under "Sign In / Register". There is no separate login or sign-up choice; the same flow does both.
2. **Email one-time code.** A verification code is emailed. No password to forget.
3. **Short profile form.** First name, last name, mobile (+852), date of birth and gender, all required. Date of birth is collected because birthday rewards are one of the strongest retention triggers; mobile is collected for staff lookup and future SMS or WhatsApp.
4. **Instant reward.** Straight after sign-up a modal says "You have claimed a reward!" (your screenshots show a Free Topping and a $5 Cash Voucher, each expiring about 30 days later). The reward is given before the customer has bought anything, which turns sign-up into a win and gives them a reason to come back within a month.
5. **"One more step left!"** The next page pushes the customer to add the card to their phone's wallet. On a computer it shows a QR to scan with the phone; on iPhone it switches to Apple Wallet. There is a Skip button, but the reward modal says the reward is reached through the "Member Center" link on the pass, which nudges people to install it.
6. **The wallet pass.** An orange Apple Wallet store card shows the logo, a "STAMPS 0/10" header, ten cup icons that fill in as stamps are collected (grey to brown), the member's name, a "Last update" timestamp and a QR code for staff to scan. When a stamp is added, the pass updates itself on the phone a moment later (3/10 at 13:05 in your screenshots), and iOS shows the change on the lock screen.
7. **Member Center (web).** "Wanpo Card: you have 3/10 stamps", a QR button, Benefits, Promo Code, History, and "My Vouchers" with each voucher's expiry date and "single use only". An EN / 中 toggle sits in the corner.

## 3. Why this kind of system retains customers

**The card lives where people already look.** A wallet pass needs no app download, no account password, and sits next to boarding passes and payment cards. Vendor benchmarks claim wallet pass add rates of 45 to 60% when offered in a one-tap flow, against under 10% for retail loyalty app installs, and far lower deletion rates than apps. These numbers come from vendors and are directional, but the direction is consistent across sources.

**Free messaging to the lock screen.** Every pass update can carry a message that appears on the lock screen like a notification, at no per-message cost (unlike SMS at around HK$0.3 to 0.6 each, or WhatsApp business messages). This is the main reason Juicysuite-style systems work: the brand can reach every member who installed the card, for free, whenever something meaningful changes.

**Location reminders.** A pass can list store coordinates. When the member walks near a shop, iOS surfaces the card on the lock screen with a short line of text. It is a passive "you're nearby" nudge that costs nothing.

**The psychology of the stamp card.**
- *Goal gradient:* people speed up as they get closer to a reward. Visible empty slots (7 of 10 grey cups) are a constant pull.
- *Endowed progress:* a card that starts with a head start (a welcome stamp or a welcome voucher) gets completed more often than an empty one.
- *Loss aversion and deadlines:* vouchers expire (Wanpo uses 30 days). An expiring reward feels like something you will lose, so it drives a visit.
- *Reciprocity:* an immediate gift at sign-up creates goodwill and a first reason to return.

**The data loop.** Each stamp is a dated visit tied to a person. That gives the shop: who is new, who is regular, who is drifting away, and who is one stamp from a reward. Campaigns can then target those groups instead of discounting to everyone.

## 4. The marketing playbook these systems run

| Trigger | Message | Why it works |
|---|---|---|
| Sign-up | Instant voucher (free topping) | Converts a stranger into a returning visitor within the voucher window |
| Every stamp | Lock-screen "You now have 4/10 stamps" | Reinforces progress, keeps the brand top of mind |
| Close to reward (8/10, 9/10) | "Just 2 stamps to a free donut" | Goal gradient: the cheapest nudge with the highest response |
| Card complete | "Reward unlocked!" | Delight moment; the reward voucher drives the next visit too |
| Birthday | Birthday treat voucher | Highest open and redemption rates of any loyalty message; often brings friends |
| Lapsed 30+ days | "We miss you" plus a voucher | Win-back before the habit is lost |
| Voucher expiring | "Use it before it melts" | Loss aversion; recovers rewards that would otherwise be wasted |
| Referral | Friend joins; referrer rewarded after the friend's first purchase | Low-cost acquisition; rewarding after the purchase stops fake sign-ups |
| Promo codes | One code per channel (IG, Xiaohongshu, flyers, KOLs) | Measures which channel actually brings members |
| Product launches, weather, seasonal | Short, rare broadcasts to opted-in members | Keeps the pass worth keeping; too many messages get it deleted |

Juicysuite's paid "Growth service" is essentially this calendar run for the merchant, plus KOL management. The admin in this project ships the same campaign types with presets.

## 5. What to copy, what to do better

**Copy:**
- The one-field email start, OTP instead of passwords, and the instant reward at sign-up.
- The "One more step left!" wallet page with a QR hand-off for desktop sign-ups.
- A pass that shows progress visually, not just as a number.
- Short voucher expiry (30 days for welcome, 60 for completed-card rewards).

**Improve:**
- **Ask for less at sign-up.** Wanpo requires gender. O! Donut makes gender optional ("Prefer not to say") and requires explicit consent for marketing (needed under Hong Kong's PDPO direct-marketing rules).
- **Reward referrals after a real purchase,** not at sign-up, to stop self-referral abuse.
- **Anti-fraud at the counter:** a per-scan stamp cap and a cooldown between purchase stamps, plus a full audit trail of who stamped what.
- **Android parity:** Google Wallet support, plus browser web push for people who skip the wallet.
- **Own your data:** members, history and campaign results live in your database, exportable as CSV, with no yearly platform fee.

## 6. KPIs to watch (all on the admin dashboard)

- **Wallet add rate:** passes installed ÷ members. Target 50%+. If lower, improve the counter signage and the wallet step.
- **Active members (30 days)** and **repeat rate** (members with 2+ visits ÷ members with 1+).
- **Cards completed per month** and **reward redemption rate** (healthy: 40 to 70%; very low means rewards are not valued, very high means the card may be too easy).
- **Cohort retention:** share of each month's sign-ups still visiting after 30 days.
- **Campaign redemptions:** vouchers redeemed per campaign, so you stop sending what does not work.

## Sources

- [Juicysuite on the Cyberport digital tech supplier list](https://dtspp.cyberport.hk/product/juicysuite-membership-portal-and-e-wallet-4)
- [Juicysuite: Loyalty & Rewards on the Shopify App Store](https://apps.shopify.com/juicysuite-platform?locale=th)
- [Juicysuite on SleekFlow's partner directory](https://sleekflow.io/en-us/partner-directory/juicysuite.md)
- [Apple: Loyalty and membership passes](https://developer.apple.com/wallet/loyalty-passes/)
- [JeriCommerce: mobile wallet loyalty program guide](https://blog.jericommerce.com/guides/mobile-wallet-loyalty-program) (vendor benchmarks; treat as directional)
- Your eight screenshots of the Wanpo sign-up, wallet pass and Member Center (14 to 15 October 2026)
