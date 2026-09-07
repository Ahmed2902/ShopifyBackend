-- Analytics and intelligence cohort demand by processedAt when Shopify provides it.
-- Mirror the existing shopifyCreatedAt test-order index so PostgreSQL can use a
-- BitmapOr across the processed/fallback branches instead of scanning a store's orders.
CREATE INDEX "Order_storeId_isTest_processedAt_idx"
ON "Order"("storeId", "isTest", "processedAt");
