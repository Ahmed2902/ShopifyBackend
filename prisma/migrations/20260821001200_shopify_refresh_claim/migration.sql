-- Serialize rotating Shopify offline-token refreshes across workers/instances.
ALTER TABLE "ShopifyConnection"
ADD COLUMN "refreshClaimedAt" TIMESTAMP(3);

CREATE INDEX "ShopifyConnection_refreshClaimedAt_idx"
ON "ShopifyConnection"("refreshClaimedAt");
