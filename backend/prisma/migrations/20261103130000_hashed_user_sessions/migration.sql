-- User sessions previously stored raw bearer tokens. Revoke existing sessions,
-- remove those credentials, and persist only SHA-256 token hashes going forward.
ALTER TABLE "user_sessions" ADD COLUMN "token_hash" VARCHAR(64);

UPDATE "user_sessions"
SET "revoked_at" = COALESCE("revoked_at", CURRENT_TIMESTAMP),
    "token_hash" = REPLACE("id"::text, '-', '');

ALTER TABLE "user_sessions" ALTER COLUMN "token_hash" SET NOT NULL;
ALTER TABLE "user_sessions" DROP COLUMN "token";

CREATE UNIQUE INDEX "user_sessions_token_hash_key" ON "user_sessions"("token_hash");
