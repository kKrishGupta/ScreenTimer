ALTER TABLE "organizations"
  ADD COLUMN IF NOT EXISTS "timezone" VARCHAR(64);

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "monitoring_consent_at" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "monitoring_consent_revoked_at" TIMESTAMPTZ(3),
  ADD COLUMN IF NOT EXISTS "monitoring_consent_version" VARCHAR(64);

-- Prior default-true flags were not tied to an explicit administrator decision.
-- Require a fresh explicit authorization before any account can collect data.
ALTER TABLE "users" ALTER COLUMN "monitoring_authorized" SET DEFAULT false;
UPDATE "users" SET "monitoring_authorized" = false WHERE "monitoring_authorized" = true;

-- Existing monitoring_authorized values only represent administrator policy.
-- They are not evidence of user consent, so all existing users remain blocked
-- from collection until they explicitly consent through their own account.
