ALTER TABLE "invitations"
  ALTER COLUMN "token" DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS "display_name" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "shift_start" VARCHAR(16),
  ADD COLUMN IF NOT EXISTS "shift_end" VARCHAR(16),
  ADD COLUMN IF NOT EXISTS "working_days" TEXT[] NOT NULL DEFAULT ARRAY['Mon', 'Tue', 'Wed', 'Thu', 'Fri']::TEXT[],
  ADD COLUMN IF NOT EXISTS "shift_timezone" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "revoked_at" TIMESTAMPTZ(3);

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "shift_timezone" VARCHAR(64);

-- Earlier application versions persisted the bearer token alongside its hash.
-- Keep usable hashed invitations, expire unverifiable legacy rows, and erase
-- the raw token from every existing invitation.
UPDATE "invitations"
SET "revoked_at" = CASE
      WHEN "token_hash" IS NULL AND "accepted_at" IS NULL THEN COALESCE("revoked_at", CURRENT_TIMESTAMP)
      ELSE "revoked_at"
    END,
    "token" = NULL
WHERE "token" IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS "invitations_token_hash_key"
  ON "invitations"("token_hash");
