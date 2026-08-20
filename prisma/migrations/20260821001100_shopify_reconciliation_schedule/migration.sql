ALTER TABLE "ShopifyConnection"
  ADD COLUMN "reconciliationIntervalMinutes" INTEGER NOT NULL DEFAULT 1440,
  ADD COLUMN "lastReconciledAt" TIMESTAMP(3),
  ADD COLUMN "nextReconciliationAt" TIMESTAMP(3),
  ADD COLUMN "reconciliationClaimedAt" TIMESTAMP(3);

UPDATE "ShopifyConnection"
SET "nextReconciliationAt" = COALESCE("lastSyncedAt", "installedAt", CURRENT_TIMESTAMP) + INTERVAL '1 day'
WHERE "status" = 'ACTIVE';

CREATE INDEX "ShopifyConnection_status_nextReconciliationAt_idx"
  ON "ShopifyConnection"("status", "nextReconciliationAt");

CREATE INDEX "ShopifyConnection_reconciliationClaimedAt_idx"
  ON "ShopifyConnection"("reconciliationClaimedAt");
