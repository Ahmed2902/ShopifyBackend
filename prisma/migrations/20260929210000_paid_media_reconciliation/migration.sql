CREATE TYPE "AdvertisingReconciliationStatus" AS ENUM ('IDLE', 'RUNNING', 'BACKOFF', 'SUSPENDED');

CREATE TABLE "AdvertisingReconciliationState" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "provider" "AdvertisingProvider" NOT NULL,
    "status" "AdvertisingReconciliationStatus" NOT NULL DEFAULT 'IDLE',
    "nextDailyAt" TIMESTAMP(3),
    "nextCatalogAt" TIMESTAMP(3),
    "manualRequestedAt" TIMESTAMP(3),
    "urgentAt" TIMESTAMP(3),
    "urgentKinds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "claimedAt" TIMESTAMP(3),
    "claimToken" TEXT,
    "lastStartedAt" TIMESTAMP(3),
    "lastSucceededAt" TIMESTAMP(3),
    "lastCatalogSucceededAt" TIMESTAMP(3),
    "failureCount" INTEGER NOT NULL DEFAULT 0,
    "retryAt" TIMESTAMP(3),
    "suspendedReason" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdvertisingReconciliationState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdvertisingReconciliationState_storeId_provider_key" ON "AdvertisingReconciliationState"("storeId", "provider");
CREATE INDEX "AdvertisingReconciliationState_status_nextDailyAt_idx" ON "AdvertisingReconciliationState"("status", "nextDailyAt");
CREATE INDEX "AdvertisingReconciliationState_status_retryAt_idx" ON "AdvertisingReconciliationState"("status", "retryAt");
CREATE INDEX "AdvertisingReconciliationState_manualRequestedAt_idx" ON "AdvertisingReconciliationState"("manualRequestedAt");
CREATE INDEX "AdvertisingReconciliationState_urgentAt_idx" ON "AdvertisingReconciliationState"("urgentAt");
CREATE INDEX "AdvertisingReconciliationState_claimedAt_idx" ON "AdvertisingReconciliationState"("claimedAt");

ALTER TABLE "AdvertisingReconciliationState" ADD CONSTRAINT "AdvertisingReconciliationState_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
