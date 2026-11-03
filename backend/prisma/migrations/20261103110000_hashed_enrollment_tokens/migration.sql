ALTER TABLE "device_enrollment_tokens"
  ALTER COLUMN "token" DROP NOT NULL;
ALTER TABLE "device_enrollment_tokens"
  ADD COLUMN "token_hash" VARCHAR(64);
CREATE UNIQUE INDEX "device_enrollment_tokens_token_hash_key"
  ON "device_enrollment_tokens"("token_hash");
