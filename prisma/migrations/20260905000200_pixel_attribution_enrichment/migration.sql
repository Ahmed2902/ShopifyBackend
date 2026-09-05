CREATE TYPE "StorefrontAttributionDimension" AS ENUM ('SOURCE', 'META_AD');
CREATE TYPE "StorefrontAttributionTargetType" AS ENUM ('PRODUCT', 'COLLECTION');

CREATE TABLE "StorefrontAttributionDaily" (
  "id" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "bucketDate" DATE NOT NULL,
  "dimension" "StorefrontAttributionDimension" NOT NULL,
  "dimensionKey" VARCHAR(320) NOT NULL,
  "source" "StorefrontJourneySource" NOT NULL,
  "metaCampaignId" UUID,
  "metaAdSetId" UUID,
  "metaAdId" UUID,
  "metaCampaignExternalId" VARCHAR(128),
  "metaAdSetExternalId" VARCHAR(128),
  "metaAdExternalId" VARCHAR(128),
  "touchedSessionCount" INTEGER NOT NULL DEFAULT 0,
  "linkedPurchaseSessionCount" INTEGER NOT NULL DEFAULT 0,
  "firstTouchPurchaseSessionCount" INTEGER NOT NULL DEFAULT 0,
  "lastTouchPurchaseSessionCount" INTEGER NOT NULL DEFAULT 0,
  "assistedPurchaseSessionCount" INTEGER NOT NULL DEFAULT 0,
  "singleTouchPurchaseSessionCount" INTEGER NOT NULL DEFAULT 0,
  "crossSessionPurchaseCount" INTEGER NOT NULL DEFAULT 0,
  "conversionDelayMsTotal" BIGINT NOT NULL DEFAULT 0,
  "conversionDelayCount" INTEGER NOT NULL DEFAULT 0,
  "exactMetaResolutionSessionCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StorefrontAttributionDaily_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StorefrontAttributionPathDaily" (
  "id" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "bucketDate" DATE NOT NULL,
  "pathHash" VARCHAR(64) NOT NULL,
  "path" VARCHAR(512) NOT NULL,
  "sessionCount" INTEGER NOT NULL DEFAULT 0,
  "linkedPurchaseSessionCount" INTEGER NOT NULL DEFAULT 0,
  "crossSessionPurchaseCount" INTEGER NOT NULL DEFAULT 0,
  "conversionDelayMsTotal" BIGINT NOT NULL DEFAULT 0,
  "conversionDelayCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StorefrontAttributionPathDaily_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StorefrontMetaTargetEvidenceDaily" (
  "id" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "bucketDate" DATE NOT NULL,
  "metaAdId" UUID NOT NULL,
  "metaAdExternalId" VARCHAR(128) NOT NULL,
  "targetType" "StorefrontAttributionTargetType" NOT NULL,
  "targetKey" VARCHAR(320) NOT NULL,
  "productId" UUID,
  "collectionId" UUID,
  "productExternalId" VARCHAR(128),
  "variantExternalId" VARCHAR(128),
  "collectionExternalId" VARCHAR(128),
  "interactedSessionCount" INTEGER NOT NULL DEFAULT 0,
  "viewedSessionCount" INTEGER NOT NULL DEFAULT 0,
  "addToCartSessionCount" INTEGER NOT NULL DEFAULT 0,
  "linkedPurchaseSessionCount" INTEGER NOT NULL DEFAULT 0,
  "firstTouchPurchaseSessionCount" INTEGER NOT NULL DEFAULT 0,
  "lastTouchPurchaseSessionCount" INTEGER NOT NULL DEFAULT 0,
  "assistedPurchaseSessionCount" INTEGER NOT NULL DEFAULT 0,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StorefrontMetaTargetEvidenceDaily_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StorefrontAttributionRollupState" (
  "id" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "rolledThroughSessionUpdatedAt" TIMESTAMP(3),
  "lastRolledUpAt" TIMESTAMP(3),
  "lastError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StorefrontAttributionRollupState_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StorefrontAttributionDaily_store_date_dim_key"
  ON "StorefrontAttributionDaily"("storeId", "bucketDate", "dimension", "dimensionKey");
CREATE INDEX "StorefrontAttributionDaily_store_date_dim_idx"
  ON "StorefrontAttributionDaily"("storeId", "bucketDate", "dimension");
CREATE INDEX "StorefrontAttributionDaily_meta_ad_date_idx"
  ON "StorefrontAttributionDaily"("storeId", "metaAdId", "bucketDate");

CREATE UNIQUE INDEX "StorefrontAttributionPathDaily_store_date_path_key"
  ON "StorefrontAttributionPathDaily"("storeId", "bucketDate", "pathHash");
CREATE INDEX "StorefrontAttributionPathDaily_store_date_idx"
  ON "StorefrontAttributionPathDaily"("storeId", "bucketDate");

CREATE UNIQUE INDEX "StorefrontMetaTargetEvidenceDaily_store_date_target_key"
  ON "StorefrontMetaTargetEvidenceDaily"("storeId", "bucketDate", "metaAdId", "targetType", "targetKey");
CREATE INDEX "StorefrontMetaTargetEvidenceDaily_meta_ad_date_idx"
  ON "StorefrontMetaTargetEvidenceDaily"("storeId", "metaAdId", "bucketDate");
CREATE INDEX "StorefrontMetaTargetEvidenceDaily_product_date_idx"
  ON "StorefrontMetaTargetEvidenceDaily"("storeId", "productId", "bucketDate");
CREATE INDEX "StorefrontMetaTargetEvidenceDaily_collection_date_idx"
  ON "StorefrontMetaTargetEvidenceDaily"("storeId", "collectionId", "bucketDate");

CREATE UNIQUE INDEX "StorefrontAttributionRollupState_store_key"
  ON "StorefrontAttributionRollupState"("storeId");

ALTER TABLE "StorefrontAttributionDaily"
  ADD CONSTRAINT "StorefrontAttributionDaily_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StorefrontAttributionPathDaily"
  ADD CONSTRAINT "StorefrontAttributionPathDaily_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StorefrontMetaTargetEvidenceDaily"
  ADD CONSTRAINT "StorefrontMetaTargetEvidenceDaily_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StorefrontAttributionRollupState"
  ADD CONSTRAINT "StorefrontAttributionRollupState_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
