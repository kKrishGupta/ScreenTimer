-- Preserve device-linked activity, screenshots, reports and audit history while
-- permanently removing revoked devices from operational device directories.
ALTER TABLE "devices"
  ADD COLUMN "deleted_at" TIMESTAMPTZ(3),
  ADD COLUMN "deleted_by_user_id" UUID;

CREATE INDEX "devices_organization_id_deleted_at_idx"
  ON "devices"("organization_id", "deleted_at");
