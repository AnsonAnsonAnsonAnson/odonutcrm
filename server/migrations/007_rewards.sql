-- Spend-based stamps, a welcome stamp on sign-up, and an optional number of vouchers per completed card.
-- O! Donut's rules (2026-10-24): 1 stamp per $40, first stamp free on joining, a free cream
-- cheese donut for signing up, and 2 free donuts for 10 stamps, as one voucher used in one go.

-- 0 means "staff count stamps by hand" (the old way).
ALTER TABLE program ADD COLUMN spend_per_stamp numeric(10,2) NOT NULL DEFAULT 40 CHECK (spend_per_stamp >= 0);
ALTER TABLE program ADD COLUMN signup_stamps integer NOT NULL DEFAULT 1 CHECK (signup_stamps BETWEEN 0 AND 5);
ALTER TABLE program ADD COLUMN reward_voucher_count integer NOT NULL DEFAULT 1 CHECK (reward_voucher_count BETWEEN 1 AND 5);
-- Short words for the reward, shown on the join page, the member card and the Wallet pass.
ALTER TABLE program ADD COLUMN reward_summary text NOT NULL DEFAULT '2 free donuts';

-- What the member spent on each purchase stamp, and in total, for the CRM.
ALTER TABLE stamp_events ADD COLUMN amount numeric(10,2) CHECK (amount >= 0);
ALTER TABLE customers ADD COLUMN total_spend numeric(12,2) NOT NULL DEFAULT 0;

-- Starter vouchers and wording: only change them if the owner hasn't already edited them.
UPDATE voucher_templates SET title = 'Free Cream Cheese Donut',
       description = 'Welcome to the club! Enjoy a free cream cheese donut on us.'
 WHERE id = (SELECT welcome_template_id FROM program WHERE id = 1) AND title = 'Free Topping';
UPDATE voucher_templates SET title = '2 Free Donuts',
       description = 'You completed your stamp card! Two classic donuts on us, used together in one visit.'
 WHERE id = (SELECT reward_template_id FROM program WHERE id = 1) AND title = 'Free Donut';
UPDATE program SET terms = 'Collect 1 stamp for every $40 spent in one purchase. 10 stamps earn 2 free donuts. Rewards are single use and cannot be exchanged for cash.'
 WHERE id = 1 AND terms = 'Collect 1 stamp per qualifying purchase. Rewards are single use and cannot be exchanged for cash.';
