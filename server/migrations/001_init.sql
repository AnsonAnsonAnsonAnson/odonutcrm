-- O! Donut loyalty: initial schema
CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE stores (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  address       text,
  latitude      double precision,
  longitude     double precision,
  relevant_text text,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE staff_users (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email         text NOT NULL UNIQUE,
  name          text NOT NULL,
  password_hash text NOT NULL,
  role          text NOT NULL CHECK (role IN ('owner','manager','staff')),
  store_id      uuid REFERENCES stores(id) ON DELETE SET NULL,
  active        boolean NOT NULL DEFAULT true,
  created_at    timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz
);

CREATE TABLE voucher_templates (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  title       text NOT NULL,
  description text NOT NULL DEFAULT '',
  kind        text NOT NULL CHECK (kind IN ('free_item','cash','percent')),
  value       numeric(10,2) NOT NULL DEFAULT 0,
  valid_days  integer NOT NULL DEFAULT 30 CHECK (valid_days > 0),
  active      boolean NOT NULL DEFAULT true,
  created_at  timestamptz NOT NULL DEFAULT now()
);

-- Single-row program settings (id = 1). Automations live here as simple switches.
CREATE TABLE program (
  id                     integer PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  name                   text NOT NULL DEFAULT 'O! Donut Card',
  brand_name             text NOT NULL DEFAULT 'O! Donut',
  stamps_required        integer NOT NULL DEFAULT 10 CHECK (stamps_required BETWEEN 2 AND 20),
  max_stamps_per_scan    integer NOT NULL DEFAULT 5 CHECK (max_stamps_per_scan >= 1),
  stamp_cooldown_seconds integer NOT NULL DEFAULT 60 CHECK (stamp_cooldown_seconds >= 0),
  background_color       text NOT NULL DEFAULT '#F25C8A',
  foreground_color       text NOT NULL DEFAULT '#3B1F14',
  label_color            text NOT NULL DEFAULT '#FFFFFF',
  reward_template_id     uuid REFERENCES voucher_templates(id),
  welcome_template_id    uuid REFERENCES voucher_templates(id),
  birthday_enabled       boolean NOT NULL DEFAULT true,
  birthday_template_id   uuid REFERENCES voucher_templates(id),
  birthday_message       text NOT NULL DEFAULT 'Happy birthday from O! Donut! A treat is waiting in your wallet.',
  winback_enabled        boolean NOT NULL DEFAULT true,
  winback_days           integer NOT NULL DEFAULT 30 CHECK (winback_days >= 7),
  winback_template_id    uuid REFERENCES voucher_templates(id),
  winback_message        text NOT NULL DEFAULT 'We miss you! Here is something sweet to bring you back.',
  referral_enabled       boolean NOT NULL DEFAULT true,
  referral_template_id   uuid REFERENCES voucher_templates(id),
  expiry_reminder_days   integer NOT NULL DEFAULT 3,
  terms                  text NOT NULL DEFAULT 'Collect 1 stamp per qualifying purchase. Rewards are single use and cannot be exchanged for cash.',
  updated_at             timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE customers (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email            text NOT NULL UNIQUE,
  first_name       text NOT NULL,
  last_name        text NOT NULL,
  phone            text,
  birthday         date,
  gender           text CHECK (gender IN ('male','female','other','undisclosed')),
  locale           text NOT NULL DEFAULT 'en',
  marketing_opt_in boolean NOT NULL DEFAULT false,
  referral_code    text NOT NULL UNIQUE,
  referred_by      uuid REFERENCES customers(id) ON DELETE SET NULL,
  tags             text[] NOT NULL DEFAULT '{}',
  notes            text NOT NULL DEFAULT '',
  created_at       timestamptz NOT NULL DEFAULT now(),
  last_visit_at    timestamptz,
  visit_count      integer NOT NULL DEFAULT 0,
  last_birthday_reward_year integer,
  last_winback_at  timestamptz
);
CREATE INDEX customers_last_visit_idx ON customers (last_visit_at);
CREATE INDEX customers_birthday_md_idx ON customers ((extract(month FROM birthday)), (extract(day FROM birthday)));

CREATE TABLE otp_codes (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email       text NOT NULL,
  code_hash   text NOT NULL,
  attempts    integer NOT NULL DEFAULT 0,
  expires_at  timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX otp_codes_email_idx ON otp_codes (email, created_at DESC);

-- One loyalty card per customer. serial_number + auth_token are what Apple Wallet uses;
-- qr_token is what the staff scanner reads (rotatable without reissuing the pass).
CREATE TABLE cards (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id        uuid NOT NULL UNIQUE REFERENCES customers(id) ON DELETE CASCADE,
  serial_number      text NOT NULL UNIQUE,
  auth_token         text NOT NULL,
  qr_token           text NOT NULL UNIQUE,
  stamps             integer NOT NULL DEFAULT 0 CHECK (stamps >= 0),
  lifetime_stamps    integer NOT NULL DEFAULT 0,
  rewards_earned     integer NOT NULL DEFAULT 0,
  message            text,
  message_updated_at timestamptz,
  google_saved       boolean NOT NULL DEFAULT false,
  created_at         timestamptz NOT NULL DEFAULT now(),
  updated_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE stamp_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  card_id         uuid NOT NULL REFERENCES cards(id) ON DELETE CASCADE,
  delta           integer NOT NULL,
  reason          text NOT NULL CHECK (reason IN ('purchase','bonus','adjustment','reward_rollover')),
  staff_id        uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  store_id        uuid REFERENCES stores(id) ON DELETE SET NULL,
  note            text,
  idempotency_key text UNIQUE,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX stamp_events_card_idx ON stamp_events (card_id, created_at DESC);
CREATE INDEX stamp_events_created_idx ON stamp_events (created_at);

CREATE TABLE promo_codes (
  id                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  code               text NOT NULL UNIQUE,
  template_id        uuid NOT NULL REFERENCES voucher_templates(id),
  max_uses           integer,
  uses               integer NOT NULL DEFAULT 0,
  starts_at          timestamptz,
  ends_at            timestamptz,
  active             boolean NOT NULL DEFAULT true,
  created_at         timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE campaigns (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name             text NOT NULL,
  message          text NOT NULL,
  template_id      uuid REFERENCES voucher_templates(id),
  segment          jsonb NOT NULL DEFAULT '{}',
  status           text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','scheduled','sending','sent','cancelled')),
  scheduled_at     timestamptz,
  sent_at          timestamptz,
  recipients       integer NOT NULL DEFAULT 0,
  created_by       uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  created_at       timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE vouchers (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id       uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  template_id       uuid NOT NULL REFERENCES voucher_templates(id),
  code              text NOT NULL UNIQUE,
  status            text NOT NULL DEFAULT 'active' CHECK (status IN ('active','redeemed','expired','void')),
  source            text NOT NULL CHECK (source IN ('welcome','stamp_reward','birthday','winback','promo','referral','campaign','manual')),
  source_ref        uuid,
  expires_at        timestamptz NOT NULL,
  reminder_sent_at  timestamptz,
  redeemed_at       timestamptz,
  redeemed_by       uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  redeemed_store_id uuid REFERENCES stores(id) ON DELETE SET NULL,
  created_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX vouchers_customer_idx ON vouchers (customer_id, status);
CREATE INDEX vouchers_expiry_idx ON vouchers (status, expires_at);
-- One voucher per customer per promo code / campaign.
CREATE UNIQUE INDEX vouchers_once_per_source_idx ON vouchers (customer_id, source, source_ref)
  WHERE source IN ('promo','campaign','referral') AND source_ref IS NOT NULL;

CREATE TABLE notifications (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  campaign_id uuid REFERENCES campaigns(id) ON DELETE SET NULL,
  kind        text NOT NULL,
  title       text NOT NULL,
  body        text NOT NULL,
  channels    text[] NOT NULL DEFAULT '{}',
  created_at  timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX notifications_customer_idx ON notifications (customer_id, created_at DESC);

-- Apple Wallet web service registrations
CREATE TABLE apple_devices (
  device_library_id text PRIMARY KEY,
  push_token        text NOT NULL,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE apple_registrations (
  device_library_id text NOT NULL REFERENCES apple_devices(device_library_id) ON DELETE CASCADE,
  pass_type_id      text NOT NULL,
  serial_number     text NOT NULL REFERENCES cards(serial_number) ON DELETE CASCADE,
  created_at        timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (device_library_id, pass_type_id, serial_number)
);
CREATE INDEX apple_registrations_serial_idx ON apple_registrations (serial_number);

CREATE TABLE apple_logs (
  id         bigserial PRIMARY KEY,
  message    text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE web_push_subscriptions (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id uuid NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
  endpoint    text NOT NULL UNIQUE,
  p256dh      text NOT NULL,
  auth        text NOT NULL,
  created_at  timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE job_runs (
  job        text NOT NULL,
  run_key    text NOT NULL,
  ran_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (job, run_key)
);
