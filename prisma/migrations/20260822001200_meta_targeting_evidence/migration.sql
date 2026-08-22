-- Extend Meta advertising data so ads can map to a product, a product option
-- such as Color=Black, an exact variant, or multiple products without inventing
-- precision that the provider does not expose.

-- CreateEnum
CREATE TYPE "AdProductMappingGranularity" AS ENUM ('PRODUCT', 'PRODUCT_OPTION', 'VARIANT');

-- CreateEnum
CREATE TYPE "MetaAdTargetScope" AS ENUM ('STORE', 'COLLECTION', 'PRODUCT', 'PRODUCT_OPTION', 'VARIANT', 'MULTI_PRODUCT', 'UNKNOWN');

-- AlterEnum
ALTER TYPE "AdProductMappingSource" ADD VALUE 'CREATIVE_TEXT';

-- AlterEnum
ALTER TYPE "MetaInsightActionKind" ADD VALUE 'UNIQUE_ACTION';
ALTER TYPE "MetaInsightActionKind" ADD VALUE 'COST_PER_UNIQUE_ACTION';
ALTER TYPE "MetaInsightActionKind" ADD VALUE 'CONVERSION';
ALTER TYPE "MetaInsightActionKind" ADD VALUE 'CONVERSION_VALUE';

-- AlterTable
ALTER TABLE "MetaAdSet"
  ADD COLUMN "destinationType" TEXT,
  ADD COLUMN "isDynamicCreative" BOOLEAN;

-- AlterTable
ALTER TABLE "MetaCreative"
  ADD COLUMN "effectiveObjectStoryId" TEXT,
  ADD COLUMN "effectiveInstagramMediaId" TEXT,
  ADD COLUMN "degreesOfFreedomSpec" JSONB,
  ADD COLUMN "resolvedDestinationUrls" JSONB;

-- AlterTable
ALTER TABLE "MetaAd"
  ADD COLUMN "sourceAdId" TEXT,
  ADD COLUMN "targetScope" "MetaAdTargetScope" NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "targetScopeConfidence" DECIMAL(5,4),
  ADD COLUMN "targetScopeEvidence" JSONB,
  ADD COLUMN "recommendations" JSONB,
  ADD COLUMN "issuesInfo" JSONB,
  ADD COLUMN "adLabels" JSONB;

-- AlterTable
ALTER TABLE "AdProductMapping"
  ADD COLUMN "catalogItemId" UUID,
  ADD COLUMN "granularity" "AdProductMappingGranularity" NOT NULL DEFAULT 'PRODUCT',
  ADD COLUMN "optionSelector" JSONB,
  ADD COLUMN "evidenceJson" JSONB,
  ADD COLUMN "landingUrl" TEXT,
  ADD COLUMN "providerProductId" TEXT,
  ADD COLUMN "providerProductGroupId" TEXT;

-- AlterTable
ALTER TABLE "MetaInsightDaily"
  ADD COLUMN "socialSpend" DECIMAL(20,6),
  ADD COLUMN "uniqueOutboundClicks" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "inlineLinkClicks" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "inlinePostEngagement" BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN "estimatedAdRecallers" BIGINT,
  ADD COLUMN "estimatedAdRecallRate" DECIMAL(20,8),
  ADD COLUMN "actionReportTime" TEXT,
  ADD COLUMN "productIdBreakdown" TEXT,
  ADD COLUMN "productGroupIdBreakdown" TEXT,
  ADD COLUMN "websiteCtr" JSONB,
  ADD COLUMN "conversions" JSONB,
  ADD COLUMN "conversionValues" JSONB,
  ADD COLUMN "videoMetrics" JSONB;

-- AlterTable
ALTER TABLE "MetaInsightAction"
  ADD COLUMN "actionDestination" TEXT;

-- CreateIndex
CREATE INDEX "MetaAd_targetScope_idx" ON "MetaAd"("targetScope");

-- CreateIndex
CREATE INDEX "AdProductMapping_catalogItemId_validUntil_idx" ON "AdProductMapping"("catalogItemId", "validUntil");

-- CreateIndex
CREATE INDEX "AdProductMapping_granularity_source_confidence_idx" ON "AdProductMapping"("granularity", "source", "confidence");

-- DropIndex
DROP INDEX "AdProductMapping_source_confidence_idx";

-- CreateIndex
CREATE INDEX "MetaInsightDaily_productIdBreakdown_date_idx" ON "MetaInsightDaily"("productIdBreakdown", "date");

-- CreateIndex
CREATE INDEX "MetaInsightAction_actionDestination_idx" ON "MetaInsightAction"("actionDestination");

-- AddForeignKey
ALTER TABLE "AdProductMapping" ADD CONSTRAINT "AdProductMapping_catalogItemId_fkey"
  FOREIGN KEY ("catalogItemId") REFERENCES "MetaCatalogItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
