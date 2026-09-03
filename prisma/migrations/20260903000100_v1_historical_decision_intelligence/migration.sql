-- Stride V1 historical decision-intelligence foundation.
-- Predictive ML and persisted recommendations are intentionally out of V1 scope.

CREATE TYPE "InventoryIntelligenceMode" AS ENUM ('DISABLED', 'TRUSTED', 'UNRELIABLE');

-- Shopify collection support.
CREATE TABLE "Collection" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "shopifyCollectionId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "handle" TEXT,
    "descriptionHtml" TEXT,
    "sortOrder" TEXT,
    "imageUrl" TEXT,
    "shopifyUpdatedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "rawJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Collection_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ProductCollection" (
    "collectionId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "position" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ProductCollection_pkey" PRIMARY KEY ("collectionId", "productId")
);

CREATE UNIQUE INDEX "Collection_storeId_shopifyCollectionId_key" ON "Collection"("storeId", "shopifyCollectionId");
CREATE INDEX "Collection_storeId_handle_idx" ON "Collection"("storeId", "handle");
CREATE INDEX "Collection_deletedAt_idx" ON "Collection"("deletedAt");
CREATE INDEX "ProductCollection_productId_idx" ON "ProductCollection"("productId");

ALTER TABLE "Collection" ADD CONSTRAINT "Collection_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "ProductCollection" ADD CONSTRAINT "ProductCollection_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ProductCollection" ADD CONSTRAINT "ProductCollection_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Customer-journey evidence without storing customer PII or duplicate raw journey payloads.
ALTER TABLE "Order"
    ADD COLUMN "customerOrderIndex" INTEGER,
    ADD COLUMN "daysToConversion" INTEGER,
    ADD COLUMN "customerJourneyReady" BOOLEAN;

CREATE INDEX "Order_storeId_customerOrderIndex_shopifyCreatedAt_idx" ON "Order"("storeId", "customerOrderIndex", "shopifyCreatedAt");

-- Inventory trust is a tiny store-level setting, not a separate domain model.
ALTER TABLE "Store"
    ADD COLUMN "inventoryIntelligenceMode" "InventoryIntelligenceMode" NOT NULL DEFAULT 'DISABLED',
    ADD COLUMN "inventoryReviewedAt" TIMESTAMP(3);
