-- Keep the OAuth result available only to the original browser handoff.
-- Existing requests remain valid and use the legacy direct callback.
ALTER TABLE "McpAuthorizationRequest"
  ADD COLUMN "returnTokenHash" TEXT,
  ADD COLUMN "returnUrlCiphertext" TEXT,
  ADD COLUMN "decidedAt" TIMESTAMP(3);
