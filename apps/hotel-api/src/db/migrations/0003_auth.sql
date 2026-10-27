CREATE EXTENSION IF NOT EXISTS citext;

-- An installation runs exactly one property. Every row indexes the same key
-- (true), so a second property is a unique violation.
CREATE UNIQUE INDEX property_singleton ON property ((true));

CREATE TABLE app_user (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  property_id uuid NOT NULL REFERENCES property (id),
  email citext NOT NULL UNIQUE,
  name text NOT NULL,
  role text NOT NULL CHECK (role IN ('owner', 'manager', 'receptionist', 'housekeeping')),
  password_hash text NOT NULL,
  -- base32; null for roles that sign in without a second factor.
  totp_secret text,
  -- The last TOTP step accepted; a step not newer than this is a replay.
  totp_last_step bigint,
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- token_hash is SHA-256 of the cookie value; the token itself is never stored.
-- expires_at slides with use (12 h idle); absolute_expires_at never moves (7 days).
CREATE TABLE user_session (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES app_user (id) ON DELETE CASCADE,
  token_hash bytea NOT NULL UNIQUE,
  expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX user_session_user_idx ON user_session (user_id);

-- The first-run setup token: SHA-256 only, at most one row (singleton key).
CREATE TABLE setup_token (
  singleton boolean PRIMARY KEY DEFAULT true CHECK (singleton),
  token_hash bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- Login attempts per email inside the throttle window. Kept in the database so
-- a restart does not reset the count. A successful login deletes its email's rows.
CREATE TABLE login_attempt (
  id bigserial PRIMARY KEY,
  email citext NOT NULL,
  at timestamptz NOT NULL
);

CREATE INDEX login_attempt_email_at_idx ON login_attempt (email, at);
CREATE INDEX login_attempt_at_idx ON login_attempt (at);
