CREATE INDEX "SyncRun_provider_resourceType_status_createdAt_idx"
ON "SyncRun"("provider", "resourceType", "status", "createdAt");
