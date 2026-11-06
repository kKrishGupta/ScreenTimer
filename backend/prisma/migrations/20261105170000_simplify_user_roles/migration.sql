-- Simplify UserRole to SUPER_ADMIN, ADMIN and EMPLOYEE.
-- This migration was manually executed and verified in NeonDB.

CREATE TYPE "user_role_new" AS ENUM (
    'super_admin',
    'admin',
    'employee'
);

ALTER TABLE "users"
ALTER COLUMN "role" DROP DEFAULT;

ALTER TABLE "invitations"
ALTER COLUMN "role" DROP DEFAULT;

ALTER TABLE "users"
ALTER COLUMN "role" TYPE "user_role_new"
USING (
    CASE "role"::text
        WHEN 'super_admin' THEN 'super_admin'
        WHEN 'org_admin' THEN 'admin'
        WHEN 'owner' THEN 'admin'
        WHEN 'family_owner' THEN 'admin'
        WHEN 'manager' THEN 'admin'
        WHEN 'employee' THEN 'employee'
        WHEN 'member' THEN 'employee'
        WHEN 'adult_member' THEN 'employee'
        WHEN 'supervised_member' THEN 'employee'
    END
)::"user_role_new";

ALTER TABLE "invitations"
ALTER COLUMN "role" TYPE "user_role_new"
USING (
    CASE "role"::text
        WHEN 'super_admin' THEN 'super_admin'
        WHEN 'org_admin' THEN 'admin'
        WHEN 'owner' THEN 'admin'
        WHEN 'family_owner' THEN 'admin'
        WHEN 'manager' THEN 'admin'
        WHEN 'employee' THEN 'employee'
        WHEN 'member' THEN 'employee'
        WHEN 'adult_member' THEN 'employee'
        WHEN 'supervised_member' THEN 'employee'
    END
)::"user_role_new";

DROP TYPE "user_role";

ALTER TYPE "user_role_new" RENAME TO "user_role";

ALTER TABLE "users"
ALTER COLUMN "role" SET DEFAULT 'employee'::"user_role";

ALTER TABLE "invitations"
ALTER COLUMN "role" SET DEFAULT 'employee'::"user_role";
