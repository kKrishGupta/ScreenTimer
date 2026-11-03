-- AlterEnum: Add remaining user roles
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'family_owner';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'adult_member';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'supervised_member';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'super_admin';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'org_admin';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'manager';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'employee';

-- CreateEnum: grace_status
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'grace_status') THEN
    CREATE TYPE "grace_status" AS ENUM ('not_visited', 'grace_active', 'blocked', 'admin_reset');
  END IF;
END $$;

-- AlterTable: users
ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "department_id" UUID,
  ADD COLUMN IF NOT EXISTS "password_hash" VARCHAR(256),
  ADD COLUMN IF NOT EXISTS "password_salt" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "employee_number" VARCHAR(64),
  ADD COLUMN IF NOT EXISTS "manager_id" UUID,
  ADD COLUMN IF NOT EXISTS "designation" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "work_location" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "shift_start" VARCHAR(16),
  ADD COLUMN IF NOT EXISTS "shift_end" VARCHAR(16),
  ADD COLUMN IF NOT EXISTS "working_days" TEXT[] DEFAULT ARRAY['Mon', 'Tue', 'Wed', 'Thu', 'Fri']::TEXT[],
  ADD COLUMN IF NOT EXISTS "employment_status" VARCHAR(32) NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS "monitoring_authorized" BOOLEAN NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS "metadata" JSONB;

ALTER TABLE "users" ALTER COLUMN "role" SET DEFAULT 'employee';

-- AlterTable: devices
ALTER TABLE "devices"
  ADD COLUMN IF NOT EXISTS "secret_hash" VARCHAR(256),
  ADD COLUMN IF NOT EXISTS "secret_salt" VARCHAR(128),
  ADD COLUMN IF NOT EXISTS "is_revoked" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS "revoked_at" TIMESTAMPTZ(3);

-- CreateTable: sites
CREATE TABLE IF NOT EXISTS "sites" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "location" VARCHAR(256),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sites_pkey" PRIMARY KEY ("id")
);

-- CreateTable: departments
CREATE TABLE IF NOT EXISTS "departments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "site_id" UUID,
    "name" VARCHAR(128) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "departments_pkey" PRIMARY KEY ("id")
);

-- CreateTable: grace_grants
CREATE TABLE IF NOT EXISTS "grace_grants" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID,
    "device_id" UUID,
    "domain" VARCHAR(253) NOT NULL,
    "status" "grace_status" NOT NULL DEFAULT 'not_visited',
    "grace_minutes" INTEGER NOT NULL DEFAULT 15,
    "first_visited_at" TIMESTAMPTZ(3),
    "expires_at" TIMESTAMPTZ(3),
    "calendar_date" DATE NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "reset_by" VARCHAR(128),
    "reset_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "grace_grants_pkey" PRIMARY KEY ("id")
);

-- CreateTable: user_sessions
CREATE TABLE IF NOT EXISTS "user_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "user_id" UUID NOT NULL,
    "token" VARCHAR(128) NOT NULL,
    "user_agent" VARCHAR(256),
    "ip_address" VARCHAR(45),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable: device_enrollment_tokens
CREATE TABLE IF NOT EXISTS "device_enrollment_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "token" VARCHAR(128) NOT NULL,
    "organization_id" UUID NOT NULL,
    "user_id" UUID,
    "device_kind" "collector_kind" NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "revoked_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "device_enrollment_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateTable: screen_captures
CREATE TABLE IF NOT EXISTS "screen_captures" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "file_path" VARCHAR(512) NOT NULL,
    "application_name" VARCHAR(128) NOT NULL,
    "size_bytes" INTEGER NOT NULL,
    "width" INTEGER NOT NULL DEFAULT 1920,
    "height" INTEGER NOT NULL DEFAULT 1080,
    "blurred" BOOLEAN NOT NULL DEFAULT false,
    "captured_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "screen_captures_pkey" PRIMARY KEY ("id")
);

-- CreateTable: screen_share_sessions
CREATE TABLE IF NOT EXISTS "screen_share_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "device_id" UUID NOT NULL,
    "session_token" VARCHAR(128) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "duration_minutes" INTEGER NOT NULL DEFAULT 15,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "screen_share_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable: planner_tasks
CREATE TABLE IF NOT EXISTS "planner_tasks" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID,
    "title" VARCHAR(200) NOT NULL,
    "category" VARCHAR(64) NOT NULL DEFAULT 'general',
    "target_minutes" INTEGER NOT NULL DEFAULT 30,
    "completed" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "planner_tasks_pkey" PRIMARY KEY ("id")
);

-- CreateTable: focus_sessions
CREATE TABLE IF NOT EXISTS "focus_sessions" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID,
    "title" VARCHAR(128) NOT NULL,
    "duration_minutes" INTEGER NOT NULL,
    "started_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "completed" BOOLEAN NOT NULL DEFAULT false,

    CONSTRAINT "focus_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable: family_policies
CREATE TABLE IF NOT EXISTS "family_policies" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "name" VARCHAR(128) NOT NULL,
    "category" VARCHAR(64) NOT NULL,
    "restricted_domains" TEXT[],
    "restricted_apps" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "allowed_domains" TEXT[],
    "max_minutes_per_day" INTEGER NOT NULL DEFAULT 60,
    "warning_threshold_percent" INTEGER NOT NULL DEFAULT 80,
    "action" VARCHAR(32) NOT NULL DEFAULT 'warn',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "family_policies_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "family_policies"
  ADD COLUMN IF NOT EXISTS "restricted_apps" TEXT[] DEFAULT ARRAY[]::TEXT[];

-- CreateTable: policy_violations
CREATE TABLE IF NOT EXISTS "policy_violations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "policy_id" UUID,
    "device_id" UUID,
    "user_id" UUID,
    "target" VARCHAR(255) NOT NULL,
    "target_type" VARCHAR(32) NOT NULL,
    "severity" VARCHAR(32) NOT NULL DEFAULT 'warning',
    "warning_message" VARCHAR(512) NOT NULL,
    "action_taken" VARCHAR(64),
    "acknowledged" BOOLEAN NOT NULL DEFAULT false,
    "timestamp" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "policy_violations_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "policy_violations"
  ADD COLUMN IF NOT EXISTS "user_id" UUID,
  ADD COLUMN IF NOT EXISTS "action_taken" VARCHAR(64);

-- CreateTable: audit_logs
CREATE TABLE IF NOT EXISTS "audit_logs" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "action" VARCHAR(64) NOT NULL,
    "actor" VARCHAR(128) NOT NULL DEFAULT 'local_user',
    "details" JSONB,
    "timestamp" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable: invitations
CREATE TABLE IF NOT EXISTS "invitations" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "token" VARCHAR(128) NOT NULL,
    "token_hash" VARCHAR(256),
    "organization_id" UUID NOT NULL,
    "email" VARCHAR(254) NOT NULL,
    "role" "user_role" NOT NULL DEFAULT 'employee',
    "department_id" UUID,
    "invited_by" VARCHAR(128),
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "accepted_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "invitations_pkey" PRIMARY KEY ("id")
);

-- CreateTable: password_reset_tokens
CREATE TABLE IF NOT EXISTS "password_reset_tokens" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "token_hash" VARCHAR(256) NOT NULL,
    "user_id" UUID NOT NULL,
    "expires_at" TIMESTAMPTZ(3) NOT NULL,
    "used_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "password_reset_tokens_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX IF NOT EXISTS "sites_organization_id_name_key" ON "sites"("organization_id", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "departments_organization_id_name_key" ON "departments"("organization_id", "name");
CREATE UNIQUE INDEX IF NOT EXISTS "grace_grants_organization_id_domain_calendar_date_key" ON "grace_grants"("organization_id", "domain", "calendar_date");
CREATE INDEX IF NOT EXISTS "grace_grants_organization_id_status_idx" ON "grace_grants"("organization_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "user_sessions_token_key" ON "user_sessions"("token");
CREATE INDEX IF NOT EXISTS "user_sessions_user_id_expires_at_idx" ON "user_sessions"("user_id", "expires_at");
CREATE UNIQUE INDEX IF NOT EXISTS "device_enrollment_tokens_token_key" ON "device_enrollment_tokens"("token");
CREATE INDEX IF NOT EXISTS "device_enrollment_tokens_token_idx" ON "device_enrollment_tokens"("token");
CREATE INDEX IF NOT EXISTS "device_enrollment_tokens_organization_id_idx" ON "device_enrollment_tokens"("organization_id");
CREATE INDEX IF NOT EXISTS "screen_captures_organization_id_captured_at_idx" ON "screen_captures"("organization_id", "captured_at");
CREATE UNIQUE INDEX IF NOT EXISTS "screen_share_sessions_session_token_key" ON "screen_share_sessions"("session_token");
CREATE INDEX IF NOT EXISTS "planner_tasks_organization_id_completed_idx" ON "planner_tasks"("organization_id", "completed");
CREATE INDEX IF NOT EXISTS "policy_violations_organization_id_acknowledged_idx" ON "policy_violations"("organization_id", "acknowledged");
CREATE INDEX IF NOT EXISTS "audit_logs_organization_id_timestamp_idx" ON "audit_logs"("organization_id", "timestamp");
CREATE UNIQUE INDEX IF NOT EXISTS "invitations_token_key" ON "invitations"("token");
CREATE INDEX IF NOT EXISTS "invitations_organization_id_idx" ON "invitations"("organization_id");
CREATE INDEX IF NOT EXISTS "invitations_token_idx" ON "invitations"("token");
CREATE UNIQUE INDEX IF NOT EXISTS "password_reset_tokens_token_hash_key" ON "password_reset_tokens"("token_hash");
CREATE INDEX IF NOT EXISTS "password_reset_tokens_user_id_idx" ON "password_reset_tokens"("user_id");

-- Foreign Keys (using DO blocks to ensure idempotency)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'sites_organization_id_fkey') THEN
    ALTER TABLE "sites" ADD CONSTRAINT "sites_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'departments_organization_id_fkey') THEN
    ALTER TABLE "departments" ADD CONSTRAINT "departments_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'departments_site_id_fkey') THEN
    ALTER TABLE "departments" ADD CONSTRAINT "departments_site_id_fkey" FOREIGN KEY ("site_id") REFERENCES "sites"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_department_id_fkey') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_department_id_fkey" FOREIGN KEY ("department_id") REFERENCES "departments"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'users_manager_id_fkey') THEN
    ALTER TABLE "users" ADD CONSTRAINT "users_manager_id_fkey" FOREIGN KEY ("manager_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'grace_grants_organization_id_fkey') THEN
    ALTER TABLE "grace_grants" ADD CONSTRAINT "grace_grants_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'grace_grants_user_id_fkey') THEN
    ALTER TABLE "grace_grants" ADD CONSTRAINT "grace_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'user_sessions_user_id_fkey') THEN
    ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_enrollment_tokens_organization_id_fkey') THEN
    ALTER TABLE "device_enrollment_tokens" ADD CONSTRAINT "device_enrollment_tokens_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_enrollment_tokens_user_id_fkey') THEN
    ALTER TABLE "device_enrollment_tokens" ADD CONSTRAINT "device_enrollment_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'screen_captures_organization_id_fkey') THEN
    ALTER TABLE "screen_captures" ADD CONSTRAINT "screen_captures_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'screen_captures_device_id_fkey') THEN
    ALTER TABLE "screen_captures" ADD CONSTRAINT "screen_captures_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'screen_share_sessions_organization_id_fkey') THEN
    ALTER TABLE "screen_share_sessions" ADD CONSTRAINT "screen_share_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'screen_share_sessions_device_id_fkey') THEN
    ALTER TABLE "screen_share_sessions" ADD CONSTRAINT "screen_share_sessions_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'planner_tasks_organization_id_fkey') THEN
    ALTER TABLE "planner_tasks" ADD CONSTRAINT "planner_tasks_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'planner_tasks_user_id_fkey') THEN
    ALTER TABLE "planner_tasks" ADD CONSTRAINT "planner_tasks_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'focus_sessions_organization_id_fkey') THEN
    ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'focus_sessions_user_id_fkey') THEN
    ALTER TABLE "focus_sessions" ADD CONSTRAINT "focus_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'family_policies_organization_id_fkey') THEN
    ALTER TABLE "family_policies" ADD CONSTRAINT "family_policies_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'policy_violations_organization_id_fkey') THEN
    ALTER TABLE "policy_violations" ADD CONSTRAINT "policy_violations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'policy_violations_policy_id_fkey') THEN
    ALTER TABLE "policy_violations" ADD CONSTRAINT "policy_violations_policy_id_fkey" FOREIGN KEY ("policy_id") REFERENCES "family_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'policy_violations_device_id_fkey') THEN
    ALTER TABLE "policy_violations" ADD CONSTRAINT "policy_violations_device_id_fkey" FOREIGN KEY ("device_id") REFERENCES "devices"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'policy_violations_user_id_fkey') THEN
    ALTER TABLE "policy_violations" ADD CONSTRAINT "policy_violations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'audit_logs_organization_id_fkey') THEN
    ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'invitations_organization_id_fkey') THEN
    ALTER TABLE "invitations" ADD CONSTRAINT "invitations_organization_id_fkey" FOREIGN KEY ("organization_id") REFERENCES "organizations"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'password_reset_tokens_user_id_fkey') THEN
    ALTER TABLE "password_reset_tokens" ADD CONSTRAINT "password_reset_tokens_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;
