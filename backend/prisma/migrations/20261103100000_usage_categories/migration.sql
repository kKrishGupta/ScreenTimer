CREATE TABLE "usage_categories" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "organization_id" UUID NOT NULL,
    "target" VARCHAR(253) NOT NULL,
    "target_type" VARCHAR(16) NOT NULL,
    "category" VARCHAR(16) NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL,
    CONSTRAINT "usage_categories_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "usage_categories_category_check" CHECK ("category" IN ('productive', 'neutral', 'distracting')),
    CONSTRAINT "usage_categories_target_type_check" CHECK ("target_type" IN ('APPLICATION', 'WEBSITE'))
);

CREATE UNIQUE INDEX "usage_categories_organization_id_target_target_type_key"
  ON "usage_categories"("organization_id", "target", "target_type");
CREATE INDEX "usage_categories_organization_id_category_idx"
  ON "usage_categories"("organization_id", "category");
ALTER TABLE "usage_categories"
  ADD CONSTRAINT "usage_categories_organization_id_fkey"
  FOREIGN KEY ("organization_id") REFERENCES "organizations"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
