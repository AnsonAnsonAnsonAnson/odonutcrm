-- Indexes for the admin dashboard, member search, the staff counter and the nightly jobs, so they
-- stay quick with tens of thousands of members.

-- Dashboard: sign-ups, vouchers issued and vouchers redeemed per day / last 7 and 30 days.
CREATE INDEX IF NOT EXISTS customers_created_idx ON customers (created_at);
CREATE INDEX IF NOT EXISTS vouchers_created_idx ON vouchers (created_at);
CREATE INDEX IF NOT EXISTS vouchers_redeemed_idx ON vouchers (redeemed_at) WHERE redeemed_at IS NOT NULL;

-- Rewards page (issued / redeemed per template) and Campaigns page (redeemed per campaign).
CREATE INDEX IF NOT EXISTS vouchers_template_idx ON vouchers (template_id, status);
CREATE INDEX IF NOT EXISTS vouchers_campaign_idx ON vouchers (source_ref, status) WHERE source = 'campaign';

-- Tiers page (members per tier), member page (referrals), wallet checks on every member page.
CREATE INDEX IF NOT EXISTS customers_tier_idx ON customers (tier_id);
CREATE INDEX IF NOT EXISTS customers_referred_by_idx ON customers (referred_by) WHERE referred_by IS NOT NULL;
CREATE INDEX IF NOT EXISTS web_push_customer_idx ON web_push_subscriptions (customer_id);
CREATE INDEX IF NOT EXISTS apple_devices_token_idx ON apple_devices (push_token);

-- Staff counter "find by phone": the last 8 digits of the number, as the lookup compares them.
CREATE INDEX IF NOT EXISTS customers_phone_tail_idx ON customers ((right(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), 8)));

-- Admin member search ("contains" matches on name, email and phone).
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE INDEX IF NOT EXISTS customers_email_trgm_idx ON customers USING gin (lower(email) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS customers_name_trgm_idx ON customers USING gin (lower(first_name || ' ' || last_name) gin_trgm_ops);
CREATE INDEX IF NOT EXISTS customers_phone_trgm_idx ON customers USING gin (phone gin_trgm_ops);

ANALYZE customers;
ANALYZE vouchers;
ANALYZE stamp_events;
