-- Staff account security: sign-out-everywhere, lockout after repeated wrong passwords,
-- two-step sign-in (authenticator app codes), and an activity log of sign-ins and admin changes.
ALTER TABLE staff_users
  ADD COLUMN session_version   integer NOT NULL DEFAULT 0,
  ADD COLUMN failed_logins     integer NOT NULL DEFAULT 0,
  ADD COLUMN locked_until      timestamptz,
  ADD COLUMN password_changed_at timestamptz,
  -- Authenticator secret, encrypted with a key derived from APP_SECRET.
  ADD COLUMN totp_secret_enc   text,
  ADD COLUMN totp_enabled_at   timestamptz,
  -- Last accepted 30-second step, so one code cannot be used twice.
  ADD COLUMN totp_last_step    bigint;

ALTER TABLE program ADD COLUMN require_two_step boolean NOT NULL DEFAULT false;

CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  at         timestamptz NOT NULL DEFAULT now(),
  staff_id   uuid REFERENCES staff_users(id) ON DELETE SET NULL,
  -- Who it was when no account matched (e.g. a wrong email at sign-in).
  actor      text,
  action     text NOT NULL,
  target     text,
  ip         text,
  user_agent text,
  details    jsonb
);
CREATE INDEX audit_log_at ON audit_log (at DESC);
CREATE INDEX audit_log_staff ON audit_log (staff_id, at DESC);

-- One-time backup codes for two-step sign-in (HMAC hashes), used if the phone is lost.
ALTER TABLE staff_users ADD COLUMN recovery_codes text[] NOT NULL DEFAULT '{}';
