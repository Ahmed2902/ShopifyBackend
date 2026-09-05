CREATE TYPE "StorefrontBehaviorDimension" AS ENUM (
  'STORE',
  'PRODUCT',
  'COLLECTION',
  'LANDING_PAGE'
);

CREATE TABLE "StorefrontBehaviorDaily" (
  "id" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "bucketDate" DATE NOT NULL,
  "dimension" "StorefrontBehaviorDimension" NOT NULL,
  "dimensionKey" VARCHAR(320) NOT NULL,
  "productId" UUID,
  "variantId" UUID,
  "collectionId" UUID,
  "productExternalId" VARCHAR(128),
  "variantExternalId" VARCHAR(128),
  "collectionExternalId" VARCHAR(128),
  "landingPageHash" VARCHAR(64),
  "landingPageUrl" TEXT,
  "sessionCount" INTEGER NOT NULL DEFAULT 0,
  "pageViewCount" INTEGER NOT NULL DEFAULT 0,
  "productViewCount" INTEGER NOT NULL DEFAULT 0,
  "collectionViewCount" INTEGER NOT NULL DEFAULT 0,
  "searchCount" INTEGER NOT NULL DEFAULT 0,
  "addToCartCount" INTEGER NOT NULL DEFAULT 0,
  "removeFromCartCount" INTEGER NOT NULL DEFAULT 0,
  "productViewSessionCount" INTEGER NOT NULL DEFAULT 0,
  "collectionViewSessionCount" INTEGER NOT NULL DEFAULT 0,
  "searchSessionCount" INTEGER NOT NULL DEFAULT 0,
  "addToCartSessionCount" INTEGER NOT NULL DEFAULT 0,
  "checkoutStartSessionCount" INTEGER NOT NULL DEFAULT 0,
  "checkoutCompletedSessionCount" INTEGER NOT NULL DEFAULT 0,
  "linkedPurchaseSessionCount" INTEGER NOT NULL DEFAULT 0,
  "conversionDelayMsTotal" BIGINT NOT NULL DEFAULT 0,
  "conversionDelayCount" INTEGER NOT NULL DEFAULT 0,
  "exactResolutionSessionCount" INTEGER NOT NULL DEFAULT 0,
  "partialResolutionSessionCount" INTEGER NOT NULL DEFAULT 0,
  "unresolvedResolutionSessionCount" INTEGER NOT NULL DEFAULT 0,
  "conflictResolutionSessionCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StorefrontBehaviorDaily_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StorefrontBehaviorRollupState" (
  "id" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "rolledThroughMaterializedAt" TIMESTAMP(3),
  "lastRolledUpAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StorefrontBehaviorRollupState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StorefrontBehaviorDaily_store_date_dim_key"
  ON "StorefrontBehaviorDaily"("storeId", "bucketDate", "dimension", "dimensionKey");
CREATE INDEX "StorefrontBehaviorDaily_store_date_dim_idx"
  ON "StorefrontBehaviorDaily"("storeId", "bucketDate", "dimension");
CREATE INDEX "StorefrontBehaviorDaily_product_date_idx"
  ON "StorefrontBehaviorDaily"("storeId", "productId", "bucketDate");
CREATE INDEX "StorefrontBehaviorDaily_collection_date_idx"
  ON "StorefrontBehaviorDaily"("storeId", "collectionId", "bucketDate");
CREATE INDEX "StorefrontBehaviorDaily_landing_date_idx"
  ON "StorefrontBehaviorDaily"("storeId", "landingPageHash", "bucketDate");
CREATE UNIQUE INDEX "StorefrontBehaviorRollupState_store_key"
  ON "StorefrontBehaviorRollupState"("storeId");

ALTER TABLE "StorefrontBehaviorDaily"
  ADD CONSTRAINT "StorefrontBehaviorDaily_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StorefrontBehaviorRollupState"
  ADD CONSTRAINT "StorefrontBehaviorRollupState_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
