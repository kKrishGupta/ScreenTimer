CREATE TABLE "notifications" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "user_id" UUID,
    "type" VARCHAR(64) NOT NULL,
    "severity" VARCHAR(16) NOT NULL DEFAULT 'info',
    "title" VARCHAR(120) NOT NULL,
    "message" VARCHAR(500) NOT NULL,
    "target" VARCHAR(100),
    "read" BOOLEAN NOT NULL DEFAULT false,
    "read_at" TIMESTAMPTZ(3),
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "notifications_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "notifications_organization_id_read_created_at_idx"
  ON "notifications"("organization_id", "read", "created_at");
CREATE INDEX "notifications_organization_id_user_id_created_at_idx"
  ON "notifications"("organization_id", "user_id", "created_at");
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "notifications"
  ADD CONSTRAINT "notifications_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
