ALTER TABLE "SyncRun"
ADD COLUMN "activeQueueKey" TEXT,
ADD COLUMN "leaseExpiresAt" TIMESTAMP(3);

CREATE UNIQUE INDEX "SyncRun_activeQueueKey_key"
ON "SyncRun"("activeQueueKey");

CREATE INDEX "SyncRun_queue_claim_idx"
ON "SyncRun"("provider", "resourceType", "status", "leaseExpiresAt", "createdAt");
