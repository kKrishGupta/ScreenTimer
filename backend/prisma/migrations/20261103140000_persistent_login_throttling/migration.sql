-- Shared failed-login throttling across backend instances. Store a digest of
-- the normalized login identifier so raw email addresses are not duplicated.
CREATE TABLE "login_attempts" (
  "identifier_hash" VARCHAR(64) NOT NULL,
  "failure_count" INTEGER NOT NULL DEFAULT 0,
  "first_failed_at" TIMESTAMPTZ(3) NOT NULL,
  "locked_until" TIMESTAMPTZ(3),
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "login_attempts_pkey" PRIMARY KEY ("identifier_hash")
);

CREATE INDEX "login_attempts_updated_at_idx" ON "login_attempts"("updated_at");
