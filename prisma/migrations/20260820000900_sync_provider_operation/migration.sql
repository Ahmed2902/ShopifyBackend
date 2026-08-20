ALTER TABLE "SyncRun"
  ADD COLUMN "providerOperationId" TEXT;

CREATE INDEX "SyncRun_providerOperationId_idx"
  ON "SyncRun"("providerOperationId");
