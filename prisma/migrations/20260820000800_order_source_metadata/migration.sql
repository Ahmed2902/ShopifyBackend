-- Preserve order source/test metadata so downstream analytics can distinguish
-- real merchant demand from test orders and segment sales by order channel.
ALTER TABLE "Order"
  ADD COLUMN "sourceName" TEXT,
  ADD COLUMN "isTest" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "Order_storeId_isTest_shopifyCreatedAt_idx"
  ON "Order"("storeId", "isTest", "shopifyCreatedAt");

CREATE INDEX "Order_storeId_sourceName_shopifyCreatedAt_idx"
  ON "Order"("storeId", "sourceName", "shopifyCreatedAt");
