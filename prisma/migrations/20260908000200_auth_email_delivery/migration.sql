CREATE TYPE "AuthEmailDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'SENT', 'SUPERSEDED', 'DEAD');

CREATE TABLE "AuthEmailDelivery" (
  "id" UUID NOT NULL,
  "userId" UUID NOT NULL,
  "type" "AuthTokenType" NOT NULL,
  "recipient" TEXT NOT NULL,
  "tokenHash" TEXT NOT NULL,
  "tokenCiphertext" TEXT,
  "status" "AuthEmailDeliveryStatus" NOT NULL DEFAULT 'PENDING',
  "attempts" INTEGER NOT NULL DEFAULT 0,
  "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "processingStartedAt" TIMESTAMP(3),
  "sentAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "AuthEmailDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AuthEmailDelivery_tokenHash_key" ON "AuthEmailDelivery"("tokenHash");
CREATE INDEX "AuthEmailDelivery_status_nextAttemptAt_createdAt_idx" ON "AuthEmailDelivery"("status", "nextAttemptAt", "createdAt");
CREATE INDEX "AuthEmailDelivery_processingStartedAt_idx" ON "AuthEmailDelivery"("processingStartedAt");
CREATE INDEX "AuthEmailDelivery_userId_type_createdAt_idx" ON "AuthEmailDelivery"("userId", "type", "createdAt");

ALTER TABLE "AuthEmailDelivery"
  ADD CONSTRAINT "AuthEmailDelivery_userId_fkey"
  FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;
