ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'family_owner';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'adult_member';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'supervised_member';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'super_admin';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'org_admin';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'manager';
ALTER TYPE "user_role" ADD VALUE IF NOT EXISTS 'employee';