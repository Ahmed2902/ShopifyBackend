-- Stride V1 historical decision-intelligence foundation.
-- Predictive ML is intentionally not part of this schema/runtime contract.

-- CreateEnum
CREATE TYPE "InventoryIntelligenceMode" AS ENUM ('DISABLED', 'TRUSTED', 'UNRELIABLE');
CREATE TYPE "RecommendationCategory" AS ENUM ('CAMPAIGN_EFFICIENCY', 'CREATIVE_FATIGUE', 'UNDEREXPOSED_PRODUCT', 'PAID_COMMERCE_MISMATCH', 'MARGIN_TRAP', 'INVENTORY_SPEND_CONFLICT', 'DATA_QUALITY');
CREATE TYPE "RecommendationSeverity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');
CREATE TYPE "RecommendationStatus" AS ENUM ('CREATED', 'VIEWED', 'ACCEPTED', 'DISMISSED', 'RESOLVED');
CREATE TYPE "RecommendationEntityType" AS ENUM ('STORE', 'CAMPAIGN', 'AD_SET', 'AD', 'CREATIVE', 'PRODUCT', 'VARIANT', 'COLLECTION');
CREATE TYPE "DataQualityStatus" AS ENUM ('HEALTHY', 'WARNING', 'BLOCKED');
CREATE TYPE "MetaObservedEntityType" AS ENUM ('CAMPAIGN', 'AD_SET', 'AD');

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

-- Customer-journey evidence without storing customer PII.
ALTER TABLE "Order"
    ADD COLUMN "customerOrderIndex" INTEGER,
    ADD COLUMN "daysToConversion" INTEGER,
    ADD COLUMN "customerJourneyReady" BOOLEAN,
    ADD COLUMN "customerJourneyJson" JSONB;

CREATE INDEX "Order_storeId_customerOrderIndex_shopifyCreatedAt_idx" ON "Order"("storeId", "customerOrderIndex", "shopifyCreatedAt");

-- Store-level intelligence settings.
CREATE TABLE "StoreIntelligenceSettings" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "inventoryMode" "InventoryIntelligenceMode" NOT NULL DEFAULT 'DISABLED',
    "targetRoas" DECIMAL(20,8),
    "targetCpa" DECIMAL(20,8),
    "inventoryReviewedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StoreIntelligenceSettings_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "StoreIntelligenceSettings_storeId_key" ON "StoreIntelligenceSettings"("storeId");
ALTER TABLE "StoreIntelligenceSettings" ADD CONSTRAINT "StoreIntelligenceSettings_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Append-only observation of provider-supplied Meta state. Never infer budget from spend.
CREATE TABLE "MetaEntityStateSnapshot" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "adAccountId" UUID NOT NULL,
    "entityType" "MetaObservedEntityType" NOT NULL,
    "localEntityId" UUID,
    "externalEntityId" TEXT NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "configuredStatus" TEXT,
    "effectiveStatus" TEXT,
    "objective" TEXT,
    "optimizationGoal" TEXT,
    "bidStrategy" TEXT,
    "dailyBudgetMinor" BIGINT,
    "lifetimeBudgetMinor" BIGINT,
    "budgetRemainingMinor" BIGINT,
    "spendCapMinor" BIGINT,
    "stateJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "MetaEntityStateSnapshot_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "MetaEntityStateSnapshot_storeId_entityType_externalEntityId_observedAt_idx" ON "MetaEntityStateSnapshot"("storeId", "entityType", "externalEntityId", "observedAt");
CREATE INDEX "MetaEntityStateSnapshot_adAccountId_observedAt_idx" ON "MetaEntityStateSnapshot"("adAccountId", "observedAt");
ALTER TABLE "MetaEntityStateSnapshot" ADD CONSTRAINT "MetaEntityStateSnapshot_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Data-quality observations are first-class evidence/blockers.
CREATE TABLE "DataQualitySnapshot" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "provider" "IntegrationProvider",
    "surface" TEXT NOT NULL,
    "status" "DataQualityStatus" NOT NULL,
    "code" TEXT NOT NULL,
    "metricsJson" JSONB,
    "message" TEXT,
    "observedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "DataQualitySnapshot_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "DataQualitySnapshot_storeId_surface_observedAt_idx" ON "DataQualitySnapshot"("storeId", "surface", "observedAt");
CREATE INDEX "DataQualitySnapshot_storeId_status_observedAt_idx" ON "DataQualitySnapshot"("storeId", "status", "observedAt");
CREATE INDEX "DataQualitySnapshot_provider_observedAt_idx" ON "DataQualitySnapshot"("provider", "observedAt");
ALTER TABLE "DataQualitySnapshot" ADD CONSTRAINT "DataQualitySnapshot_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Deterministic recommendation ledger and future V2 outcome telemetry.
CREATE TABLE "Recommendation" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "ruleId" TEXT NOT NULL,
    "ruleVersion" TEXT NOT NULL,
    "category" "RecommendationCategory" NOT NULL,
    "severity" "RecommendationSeverity" NOT NULL,
    "status" "RecommendationStatus" NOT NULL DEFAULT 'CREATED',
    "entityType" "RecommendationEntityType" NOT NULL,
    "entityId" TEXT,
    "externalEntityId" TEXT,
    "title" TEXT NOT NULL,
    "summary" TEXT NOT NULL,
    "suggestedAction" TEXT NOT NULL,
    "priority" DOUBLE PRECISION NOT NULL,
    "impactScore" DOUBLE PRECISION NOT NULL,
    "confidenceScore" DOUBLE PRECISION NOT NULL,
    "urgencyScore" DOUBLE PRECISION NOT NULL,
    "observationStart" TIMESTAMP(3) NOT NULL,
    "observationEnd" TIMESTAMP(3) NOT NULL,
    "comparisonStart" TIMESTAMP(3),
    "comparisonEnd" TIMESTAMP(3),
    "evidenceJson" JSONB NOT NULL,
    "blockersJson" JSONB,
    "dedupeKey" TEXT NOT NULL,
    "generatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Recommendation_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "Recommendation_storeId_dedupeKey_key" ON "Recommendation"("storeId", "dedupeKey");
CREATE INDEX "Recommendation_storeId_status_priority_idx" ON "Recommendation"("storeId", "status", "priority");
CREATE INDEX "Recommendation_storeId_category_generatedAt_idx" ON "Recommendation"("storeId", "category", "generatedAt");
CREATE INDEX "Recommendation_storeId_entityType_entityId_idx" ON "Recommendation"("storeId", "entityType", "entityId");
ALTER TABLE "Recommendation" ADD CONSTRAINT "Recommendation_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RecommendationEvent" (
    "id" UUID NOT NULL,
    "recommendationId" UUID NOT NULL,
    "status" "RecommendationStatus" NOT NULL,
    "actorUserId" UUID,
    "metadataJson" JSONB,
    "occurredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecommendationEvent_pkey" PRIMARY KEY ("id")
);
CREATE INDEX "RecommendationEvent_recommendationId_occurredAt_idx" ON "RecommendationEvent"("recommendationId", "occurredAt");
CREATE INDEX "RecommendationEvent_actorUserId_occurredAt_idx" ON "RecommendationEvent"("actorUserId", "occurredAt");
ALTER TABLE "RecommendationEvent" ADD CONSTRAINT "RecommendationEvent_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "RecommendationOutcome" (
    "id" UUID NOT NULL,
    "recommendationId" UUID NOT NULL,
    "horizonDays" INTEGER NOT NULL,
    "observedAt" TIMESTAMP(3) NOT NULL,
    "metricsJson" JSONB NOT NULL,
    "stateJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RecommendationOutcome_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "RecommendationOutcome_recommendationId_horizonDays_key" ON "RecommendationOutcome"("recommendationId", "horizonDays");
CREATE INDEX "RecommendationOutcome_observedAt_idx" ON "RecommendationOutcome"("observedAt");
ALTER TABLE "RecommendationOutcome" ADD CONSTRAINT "RecommendationOutcome_recommendationId_fkey" FOREIGN KEY ("recommendationId") REFERENCES "Recommendation"("id") ON DELETE CASCADE ON UPDATE CASCADE;
