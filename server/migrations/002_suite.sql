-- Tiers, POS API keys, SMS sign-in, near-reward nudges, privacy policy

CREATE TABLE tiers (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name                text NOT NULL,
  min_stamps          integer NOT NULL UNIQUE CHECK (min_stamps >= 0),
  perks               text NOT NULL DEFAULT '',
  upgrade_template_id uuid REFERENCES voucher_templates(id),
  color               text NOT NULL DEFAULT '#3B1F14',
  created_at          timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE customers ADD COLUMN tier_id uuid REFERENCES tiers(id) ON DELETE SET NULL;
ALTER TABLE customers ADD COLUMN tier_since timestamptz;
ALTER TABLE customers ADD COLUMN last_near_reward_at timestamptz;
CREATE INDEX customers_phone_idx ON customers (phone);

ALTER TABLE program ADD COLUMN tiers_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE program ADD COLUMN tier_window_days integer NOT NULL DEFAULT 365 CHECK (tier_window_days BETWEEN 30 AND 3650);
ALTER TABLE program ADD COLUMN near_reward_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE program ADD COLUMN near_reward_within integer NOT NULL DEFAULT 2 CHECK (near_reward_within BETWEEN 1 AND 5);
ALTER TABLE program ADD COLUMN near_reward_after_days integer NOT NULL DEFAULT 7 CHECK (near_reward_after_days BETWEEN 1 AND 90);
ALTER TABLE program ADD COLUMN near_reward_message text NOT NULL DEFAULT 'You are so close to a free donut! Pop in this week to finish your card.';
ALTER TABLE program ADD COLUMN welcome_email_enabled boolean NOT NULL DEFAULT true;
ALTER TABLE program ADD COLUMN privacy_policy text NOT NULL DEFAULT '';

-- One-time codes can now go to an email address or a mobile number.
ALTER TABLE otp_codes RENAME COLUMN email TO identity;
ALTER TABLE otp_codes ADD COLUMN channel text NOT NULL DEFAULT 'email' CHECK (channel IN ('email','sms'));

CREATE TABLE api_keys (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name         text NOT NULL,
  prefix       text NOT NULL,
  key_hash     text NOT NULL UNIQUE,
  store_id     uuid REFERENCES stores(id) ON DELETE SET NULL,
  created_by   uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at   timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

ALTER TABLE stamp_events ADD COLUMN api_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL;
ALTER TABLE vouchers ADD COLUMN redeemed_api_key_id uuid REFERENCES api_keys(id) ON DELETE SET NULL;

ALTER TABLE vouchers DROP CONSTRAINT vouchers_source_check;
ALTER TABLE vouchers ADD CONSTRAINT vouchers_source_check
  CHECK (source IN ('welcome','stamp_reward','birthday','winback','promo','referral','campaign','manual','tier_upgrade'));

-- Default tiers, counted on stamps collected in the last tier_window_days.
WITH glazed AS (
  INSERT INTO voucher_templates (title, description, kind, value, valid_days)
  VALUES ('Glazed Member Treat', 'Welcome to Glazed! Enjoy a free drink with any donut.', 'free_item', 0, 30) RETURNING id
), golden AS (
  INSERT INTO voucher_templates (title, description, kind, value, valid_days)
  VALUES ('Golden Member Box', 'You made Golden! A free box of 4 donuts on us.', 'free_item', 0, 45) RETURNING id
)
INSERT INTO tiers (name, min_stamps, perks, upgrade_template_id, color)
SELECT 'Sprinkle', 0, 'Collect stamps, birthday donut, member offers', NULL, '#F25C8A'
UNION ALL SELECT 'Glazed', 20, 'Everything in Sprinkle, plus a free drink when you reach Glazed and early access to new flavours', (SELECT id FROM glazed), '#C8742B'
UNION ALL SELECT 'Golden', 50, 'Everything in Glazed, plus a free box of 4 and member-only tastings', (SELECT id FROM golden), '#B8860B';

-- Tier upgrade vouchers are once per tier per member, like promos and campaigns.
DROP INDEX vouchers_once_per_source_idx;
CREATE UNIQUE INDEX vouchers_once_per_source_idx ON vouchers (customer_id, source, source_ref)
  WHERE source IN ('promo','campaign','referral','tier_upgrade') AND source_ref IS NOT NULL;
