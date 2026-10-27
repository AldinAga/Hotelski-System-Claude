-- Where a user's TOTP enrolment stands. A secret is armed only once a code
-- from it has been seen:
--   none       no secret (roles without TOTP, or never issued)
--   setup      issued by the first-run owner step; only POST /setup/confirm arms it
--   pending    issued by user management or the recovery CLI; the first
--              successful login with a code from it arms it
--   confirmed  armed
-- Owners and managers sign in only from 'pending' (which then becomes
-- 'confirmed') or 'confirmed'; otherwise 401 totp_not_enrolled.
ALTER TABLE app_user
  ADD COLUMN totp_state text NOT NULL DEFAULT 'none'
    CHECK (totp_state IN ('none', 'setup', 'pending', 'confirmed'));

-- Rows written before this column existed held secrets that were usable at once.
UPDATE app_user SET totp_state = 'confirmed' WHERE totp_secret IS NOT NULL;
