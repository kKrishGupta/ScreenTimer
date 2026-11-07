-- Persist organization monitoring defaults and distinguish inherited schedules
-- from employee-specific overrides. Existing explicit schedules are preserved.
ALTER TABLE "organizations"
  ADD COLUMN "monitoring_shift_start" VARCHAR(16),
  ADD COLUMN "monitoring_shift_end" VARCHAR(16),
  ADD COLUMN "monitoring_working_days" TEXT[] NOT NULL DEFAULT ARRAY['Mon', 'Tue', 'Wed', 'Thu', 'Fri']::TEXT[],
  ADD COLUMN "monitoring_config_updated_at" TIMESTAMPTZ(3),
  ADD COLUMN "monitoring_config_updated_by" VARCHAR(254);

ALTER TABLE "users"
  ADD COLUMN "schedule_override" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "configuration_updated_at" TIMESTAMPTZ(3);

UPDATE "users"
SET "schedule_override" = true
WHERE "shift_start" IS NOT NULL
   OR "shift_end" IS NOT NULL
   OR "shift_timezone" IS NOT NULL;
