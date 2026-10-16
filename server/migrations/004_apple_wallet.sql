-- Apple Wallet credentials made through the admin setup wizard (an alternative to certificate
-- files in the environment, which do not fit on serverless hosts). The private key is encrypted
-- with a key derived from APP_SECRET. One row only.
CREATE TABLE apple_wallet_credentials (
  id smallint PRIMARY KEY DEFAULT 1 CHECK (id = 1),
  pending_key_enc text,
  pending_csr text,
  pending_created_at timestamptz,
  pass_type_id text,
  team_id text,
  cert_pem text,
  key_enc text,
  wwdr_pem text,
  activated_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);
