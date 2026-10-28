-- Google sign-in, one account per mobile number, and welcome gifts once per person.

-- Google sign-in: the OAuth "Client ID" from Google Cloud (public, not a secret). Empty = off.
ALTER TABLE program ADD COLUMN google_client_id text NOT NULL DEFAULT '';
-- When SMS is set up, new members confirm their mobile number with a text code.
ALTER TABLE program ADD COLUMN verify_phone_at_signup boolean NOT NULL DEFAULT true;

-- Google's permanent account id, so a member who changes their Gmail address still matches.
ALTER TABLE customers ADD COLUMN google_sub text;
CREATE UNIQUE INDEX customers_google_sub_idx ON customers (google_sub) WHERE google_sub IS NOT NULL;

-- The mobile number as digits only (+852 6123 4567 -> 85261234567): one member per number.
ALTER TABLE customers ADD COLUMN phone_key text
  GENERATED ALWAYS AS (nullif(regexp_replace(coalesce(phone, ''), '\D', '', 'g'), '')) STORED;
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM customers WHERE phone_key IS NOT NULL GROUP BY phone_key HAVING count(*) > 1) THEN
    -- Older test sign-ups may share a number. The app still refuses new duplicates; the owner
    -- can tidy these in Admin -> Members, and the next update adds the strict rule.
    RAISE NOTICE 'Some members share a mobile number; one-per-number is enforced by the app only for now.';
    CREATE INDEX customers_phone_key_idx ON customers (phone_key);
  ELSE
    CREATE UNIQUE INDEX customers_phone_key_idx ON customers (phone_key);
  END IF;
END $$;

-- Who has already had a welcome gift, kept after an account is deleted so that deleting and
-- re-joining doesn't give the gift again. Only one-way SHA-256 fingerprints of the mobile
-- number and the email (Gmail dots and +tags removed) are stored, never the details themselves.
CREATE TABLE welcome_claims (
  key_hash   text PRIMARY KEY,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE FUNCTION od_email_key(e text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE WHEN split_part(lower(e), '@', 2) IN ('gmail.com', 'googlemail.com')
    THEN replace(regexp_replace(split_part(lower(e), '@', 1), '\+.*$', ''), '.', '') || '@gmail.com'
    ELSE regexp_replace(split_part(lower(e), '@', 1), '\+.*$', '') || '@' || split_part(lower(e), '@', 2) END
$$;

INSERT INTO welcome_claims (key_hash)
SELECT encode(sha256(convert_to('email:' || od_email_key(email), 'UTF8')), 'hex') FROM customers
UNION
SELECT encode(sha256(convert_to('phone:' || phone_key, 'UTF8')), 'hex') FROM customers WHERE phone_key IS NOT NULL
ON CONFLICT DO NOTHING;
