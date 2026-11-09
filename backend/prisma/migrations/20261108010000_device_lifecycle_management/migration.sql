-- Additive device lifecycle and enrollment-token accountability metadata.
-- Existing device rows, credentials, ownership and history remain unchanged.

ALTER TABLE "device_enrollment_tokens"
  ADD COLUMN "created_by_user_id" UUID,
  ADD COLUMN "consumed_by_device_id" UUID,
  ADD COLUMN "max_uses" INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN "use_count" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "expiry_recorded_at" TIMESTAMPTZ(3);

ALTER TABLE "devices"
  ADD COLUMN "revoked_by_user_id" UUID,
  ADD COLUMN "revocation_reason" VARCHAR(500),
  ADD COLUMN "archived_at" TIMESTAMPTZ(3),
  ADD COLUMN "archived_by_user_id" UUID,
  ADD COLUMN "archive_reason" VARCHAR(500);

CREATE INDEX "device_enrollment_tokens_created_by_user_id_idx"
  ON "device_enrollment_tokens"("created_by_user_id");

CREATE INDEX "device_enrollment_tokens_consumed_by_device_id_idx"
  ON "device_enrollment_tokens"("consumed_by_device_id");

CREATE INDEX "devices_organization_id_archived_at_idx"
  ON "devices"("organization_id", "archived_at");

CREATE INDEX "devices_organization_id_is_revoked_idx"
  ON "devices"("organization_id", "is_revoked");

ALTER TABLE "device_enrollment_tokens"
  ADD CONSTRAINT "device_enrollment_tokens_usage_bounds_check"
  CHECK ("max_uses" >= 1 AND "use_count" >= 0 AND "use_count" <= "max_uses");
