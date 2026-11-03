import { Client } from 'pg';
import dotenv from 'dotenv';
dotenv.config();

const databaseUrl = process.env.DATABASE_URL?.trim() || process.env.DATABASE?.trim();
if (!databaseUrl) {
  throw new Error('DATABASE_URL is required (legacy DATABASE is accepted)');
}

async function runAdditiveMigration() {
  const client = new Client({
    connectionString: databaseUrl,
  });

  await client.connect();
  console.log('Connected to database for enterprise additive migration.');

  try {
    // 1. Extend user_role enum
    const roles = ['super_admin', 'org_admin', 'manager', 'employee'];
    for (const r of roles) {
      await client.query(`
        DO $$ BEGIN
          ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS '${r}';
        EXCEPTION
          WHEN duplicate_object THEN null;
        END $$;
      `);
    }

    // 2. Create grace_status enum
    await client.query(`
      DO $$ BEGIN
        CREATE TYPE "grace_status" AS ENUM ('not_visited', 'grace_active', 'blocked', 'admin_reset');
      EXCEPTION
        WHEN duplicate_object THEN null;
      END $$;
    `);

    // 3. Create sites table
    await client.query(`
      CREATE TABLE IF NOT EXISTS "sites" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "organization_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "name" VARCHAR(128) NOT NULL,
        "location" VARCHAR(256),
        "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
        CONSTRAINT "sites_organization_id_name_key" UNIQUE ("organization_id", "name")
      );
    `);

    // 4. Create departments table
    await client.query(`
      CREATE TABLE IF NOT EXISTS "departments" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "organization_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "site_id" UUID REFERENCES "sites"("id") ON DELETE SET NULL,
        "name" VARCHAR(128) NOT NULL,
        "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
        CONSTRAINT "departments_organization_id_name_key" UNIQUE ("organization_id", "name")
      );
    `);

    // 5. Add department_id to users
    await client.query(`
      ALTER TABLE "users" 
      ADD COLUMN IF NOT EXISTS "department_id" UUID REFERENCES "departments"("id") ON DELETE SET NULL;
    `);

    // 6. Create grace_grants table
    await client.query(`
      CREATE TABLE IF NOT EXISTS "grace_grants" (
        "id" UUID PRIMARY KEY DEFAULT gen_random_uuid(),
        "organization_id" UUID NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
        "user_id" UUID REFERENCES "users"("id") ON DELETE SET NULL,
        "device_id" UUID,
        "domain" VARCHAR(253) NOT NULL,
        "status" "grace_status" NOT NULL DEFAULT 'not_visited',
        "grace_minutes" INTEGER NOT NULL DEFAULT 15,
        "first_visited_at" TIMESTAMPTZ(3),
        "expires_at" TIMESTAMPTZ(3),
        "calendar_date" DATE NOT NULL DEFAULT CURRENT_DATE,
        "reset_by" VARCHAR(128),
        "reset_at" TIMESTAMPTZ(3),
        "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
        "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT now(),
        CONSTRAINT "grace_grants_org_domain_date_key" UNIQUE ("organization_id", "domain", "calendar_date")
      );
      CREATE INDEX IF NOT EXISTS "grace_grants_org_status_idx" ON "grace_grants"("organization_id", "status");
    `);

    console.log('ENTERPRISE ADDITIVE MIGRATION COMPLETED SUCCESSFULLY!');
  } catch (err) {
    const code = /^[A-Z0-9_]+$/.test(err?.code || '') ? err.code : 'UNKNOWN';
    console.error(`Migration error (${code}); details were omitted to protect database connection information.`);
    throw err;
  } finally {
    await client.end();
  }
}

runAdditiveMigration().catch(() => process.exit(1));

