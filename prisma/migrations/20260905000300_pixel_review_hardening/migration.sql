ALTER TYPE "PixelInstallationStatus" ADD VALUE IF NOT EXISTS 'PROVISIONING';

ALTER TABLE "PixelInstallation"
  ADD COLUMN "pendingCollectorTokenHash" VARCHAR(64),
  ADD COLUMN "pendingCollectorTokenPrefix" VARCHAR(12);

ALTER TABLE "StorefrontSession"
  ADD COLUMN "orderLinkAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "orderLinkNextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "rollupDirtyAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "behaviorRolledUpAt" TIMESTAMP(3),
  ADD COLUMN "behaviorRolledStartedAt" TIMESTAMP(3),
  ADD COLUMN "attributionRolledUpAt" TIMESTAMP(3),
  ADD COLUMN "attributionRolledStartedAt" TIMESTAMP(3);

CREATE TABLE "StorefrontSessionRepair" (
  "id" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "browserSessionId" VARCHAR(128) NOT NULL,
  "sourceReceivedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StorefrontSessionRepair_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StorefrontSessionRepair_store_session_key"
  ON "StorefrontSessionRepair"("storeId", "browserSessionId");
CREATE INDEX "StorefrontSessionRepair_source_id_idx"
  ON "StorefrontSessionRepair"("sourceReceivedAt", "id");

CREATE INDEX "StorefrontEvent_storeId_sessionId_receivedAt_idx"
  ON "StorefrontEvent"("storeId", "sessionId", "receivedAt");

DROP INDEX IF EXISTS "StorefrontSession_storeId_orderLinkStatus_checkoutCompleted_idx";
CREATE INDEX "StorefrontSession_order_retry_idx"
  ON "StorefrontSession"("storeId", "orderLinkStatus", "orderLinkNextAttemptAt", "checkoutCompletedAt");
CREATE INDEX "StorefrontSession_rollup_dirty_idx"
  ON "StorefrontSession"("storeId", "rollupDirtyAt", "id");

ALTER TABLE "StorefrontSessionRepair"
  ADD CONSTRAINT "StorefrontSessionRepair_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
