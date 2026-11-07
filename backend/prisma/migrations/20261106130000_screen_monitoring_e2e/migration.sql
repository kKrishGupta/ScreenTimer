CREATE TABLE "screen_monitoring_settings" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "organization_id" UUID NOT NULL,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "capture_interval_seconds" INTEGER NOT NULL DEFAULT 300,
  "retention_days" INTEGER NOT NULL DEFAULT 30,
  "working_days" TEXT[] NOT NULL DEFAULT ARRAY['Mon','Tue','Wed','Thu','Fri']::TEXT[],
  "shift_start" VARCHAR(5) NOT NULL DEFAULT '09:00',
  "shift_end" VARCHAR(5) NOT NULL DEFAULT '18:00',
  "excluded_applications" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "updated_by" VARCHAR(128),
  "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "screen_monitoring_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "screen_monitoring_settings_organization_id_key" UNIQUE ("organization_id"),
  CONSTRAINT "screen_monitoring_settings_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE
);

ALTER TABLE "users" ADD COLUMN "screen_monitoring_acknowledged_at" TIMESTAMPTZ(3);
ALTER TABLE "devices" ADD COLUMN "screen_capture_enabled" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "devices" ADD COLUMN "last_screen_capture_at" TIMESTAMPTZ(3);
ALTER TABLE "devices" ADD COLUMN "last_screen_capture_failure_at" TIMESTAMPTZ(3);
ALTER TABLE "devices" ADD COLUMN "last_screen_capture_error" VARCHAR(128);

ALTER TABLE "screen_captures" ALTER COLUMN "file_path" DROP NOT NULL;
ALTER TABLE "screen_captures" ADD COLUMN "employee_id" UUID;
ALTER TABLE "screen_captures" ADD COLUMN "capture_key" VARCHAR(128);
ALTER TABLE "screen_captures" ADD COLUMN "storage_key" VARCHAR(512);
ALTER TABLE "screen_captures" ADD COLUMN "mime_type" VARCHAR(64) NOT NULL DEFAULT 'image/jpeg';
ALTER TABLE "screen_captures" ALTER COLUMN "size_bytes" SET DEFAULT 0;
ALTER TABLE "screen_captures" ADD COLUMN "capture_status" VARCHAR(32) NOT NULL DEFAULT 'stored';
ALTER TABLE "screen_captures" ADD COLUMN "failure_code" VARCHAR(128);
ALTER TABLE "screen_captures" ADD COLUMN "expires_at" TIMESTAMPTZ(3);
ALTER TABLE "screen_captures" ADD COLUMN "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP;

UPDATE "screen_captures" sc SET
  "employee_id" = d."user_id",
  "capture_key" = sc."id"::text,
  "capture_status" = 'legacy',
  "expires_at" = sc."captured_at" + INTERVAL '30 days'
FROM "devices" d WHERE d."id" = sc."device_id";

ALTER TABLE "screen_captures" ALTER COLUMN "capture_key" SET NOT NULL;
ALTER TABLE "screen_captures" ALTER COLUMN "expires_at" SET NOT NULL;
ALTER TABLE "screen_captures" ADD CONSTRAINT "screen_captures_employee_id_fkey" FOREIGN KEY ("employee_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
CREATE UNIQUE INDEX "screen_captures_device_id_capture_key_key" ON "screen_captures"("device_id", "capture_key");
CREATE INDEX "screen_captures_employee_id_captured_at_idx" ON "screen_captures"("employee_id", "captured_at");
CREATE INDEX "screen_captures_expires_at_idx" ON "screen_captures"("expires_at");
