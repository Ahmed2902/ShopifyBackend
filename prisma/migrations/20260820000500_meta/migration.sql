-- Initial meta schema.

-- CreateEnum
CREATE TYPE "AdProductMappingSource" AS ENUM ('CATALOG_ITEM', 'PRODUCT_SET', 'CREATIVE_PRODUCT_DATA', 'URL', 'UTM', 'LANDING_PAGE', 'MANUAL', 'INFERRED');

-- CreateEnum
CREATE TYPE "CatalogVariantMappingSource" AS ENUM ('RETAILER_ID_SKU', 'PRODUCT_GROUP', 'URL', 'MANUAL', 'INFERRED');

-- CreateEnum
CREATE TYPE "MetaInsightLevel" AS ENUM ('ACCOUNT', 'CAMPAIGN', 'ADSET', 'AD');

-- CreateEnum
CREATE TYPE "MetaInsightActionKind" AS ENUM ('ACTION', 'ACTION_VALUE', 'COST_PER_ACTION', 'PURCHASE_ROAS', 'WEBSITE_PURCHASE_ROAS');

-- CreateTable
CREATE TABLE "MetaAdAccount" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "metaConnectionId" UUID NOT NULL,
    "metaAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT,
    "currency" TEXT NOT NULL,
    "timezoneName" TEXT,
    "timezoneId" INTEGER,
    "timezoneOffsetHours" DECIMAL(5,2),
    "amountSpentMinor" BIGINT,
    "balanceMinor" BIGINT,
    "spendCapMinor" BIGINT,
    "lastSyncedAt" TIMESTAMP(3),
    "rawJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MetaAdAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaCampaign" (
    "id" UUID NOT NULL,
    "adAccountId" UUID NOT NULL,
    "metaCampaignId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT,
    "configuredStatus" TEXT,
    "effectiveStatus" TEXT,
    "objective" TEXT,
    "buyingType" TEXT,
    "bidStrategy" TEXT,
    "dailyBudgetMinor" BIGINT,
    "lifetimeBudgetMinor" BIGINT,
    "budgetRemainingMinor" BIGINT,
    "spendCapMinor" BIGINT,
    "startTime" TIMESTAMP(3),
    "stopTime" TIMESTAMP(3),
    "promotedObject" JSONB,
    "metaCreatedAt" TIMESTAMP(3),
    "metaUpdatedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "rawJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MetaCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaAdSet" (
    "id" UUID NOT NULL,
    "adAccountId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "metaAdSetId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT,
    "configuredStatus" TEXT,
    "effectiveStatus" TEXT,
    "dailyBudgetMinor" BIGINT,
    "lifetimeBudgetMinor" BIGINT,
    "budgetRemainingMinor" BIGINT,
    "dailySpendCapMinor" BIGINT,
    "lifetimeSpendCapMinor" BIGINT,
    "bidStrategy" TEXT,
    "bidAmountMinor" BIGINT,
    "bidConstraints" JSONB,
    "billingEvent" TEXT,
    "optimizationGoal" TEXT,
    "targeting" JSONB,
    "promotedObject" JSONB,
    "attributionSpec" JSONB,
    "startTime" TIMESTAMP(3),
    "endTime" TIMESTAMP(3),
    "learningStageInfo" JSONB,
    "metaCreatedAt" TIMESTAMP(3),
    "metaUpdatedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "rawJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MetaAdSet_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaCreative" (
    "id" UUID NOT NULL,
    "adAccountId" UUID NOT NULL,
    "metaCreativeId" TEXT NOT NULL,
    "name" TEXT,
    "title" TEXT,
    "body" TEXT,
    "callToAction" JSONB,
    "callToActionType" TEXT,
    "imageUrl" TEXT,
    "thumbnailUrl" TEXT,
    "videoId" TEXT,
    "linkUrl" TEXT,
    "linkDeepLinkUrl" TEXT,
    "objectUrl" TEXT,
    "objectStoryId" TEXT,
    "objectStorySpec" JSONB,
    "productSetId" TEXT,
    "productData" JSONB,
    "assetFeedSpec" JSONB,
    "templateUrl" TEXT,
    "templateUrlSpec" JSONB,
    "urlTags" TEXT,
    "instagramPermalinkUrl" TEXT,
    "metaCreatedAt" TIMESTAMP(3),
    "metaUpdatedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "rawJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MetaCreative_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaAd" (
    "id" UUID NOT NULL,
    "adAccountId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "adSetId" UUID NOT NULL,
    "creativeId" UUID,
    "metaAdId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "configuredStatus" TEXT,
    "effectiveStatus" TEXT,
    "conversionDomain" TEXT,
    "placement" JSONB,
    "trackingSpec" JSONB,
    "conversionSpec" JSONB,
    "metaCreatedAt" TIMESTAMP(3),
    "metaUpdatedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "rawJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MetaAd_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaProductCatalog" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "metaConnectionId" UUID NOT NULL,
    "metaCatalogId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "businessId" TEXT,
    "ownerBusinessId" TEXT,
    "vertical" TEXT,
    "productCount" INTEGER,
    "feedCount" INTEGER,
    "lastSyncedAt" TIMESTAMP(3),
    "rawJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MetaProductCatalog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaCatalogItem" (
    "id" UUID NOT NULL,
    "catalogId" UUID NOT NULL,
    "metaProductItemId" TEXT NOT NULL,
    "retailerId" TEXT,
    "retailerProductGroupId" TEXT,
    "parentProductId" TEXT,
    "name" TEXT,
    "brand" TEXT,
    "availability" TEXT,
    "priceMinor" BIGINT,
    "salePriceMinor" BIGINT,
    "currency" TEXT,
    "size" TEXT,
    "color" TEXT,
    "pattern" TEXT,
    "url" TEXT,
    "productType" TEXT,
    "customLabels" JSONB,
    "productFeedId" TEXT,
    "quantityToSellOnFacebook" INTEGER,
    "status" TEXT,
    "visibility" TEXT,
    "deletedAt" TIMESTAMP(3),
    "rawJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MetaCatalogItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CatalogItemVariantMapping" (
    "id" UUID NOT NULL,
    "catalogItemId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "source" "CatalogVariantMappingSource" NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "isMerchantConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "CatalogItemVariantMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdProductMapping" (
    "id" UUID NOT NULL,
    "metaAdId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "variantId" UUID,
    "source" "AdProductMappingSource" NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "isMerchantConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdProductMapping_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaInsightDaily" (
    "id" UUID NOT NULL,
    "insightKey" TEXT NOT NULL,
    "adAccountId" UUID NOT NULL,
    "campaignId" UUID,
    "adSetId" UUID,
    "adId" UUID,
    "level" "MetaInsightLevel" NOT NULL,
    "date" DATE NOT NULL,
    "accountCurrency" TEXT NOT NULL,
    "spend" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "impressions" BIGINT NOT NULL DEFAULT 0,
    "reach" BIGINT NOT NULL DEFAULT 0,
    "clicks" BIGINT NOT NULL DEFAULT 0,
    "uniqueClicks" BIGINT NOT NULL DEFAULT 0,
    "outboundClicks" BIGINT NOT NULL DEFAULT 0,
    "cpc" DECIMAL(20,8),
    "cpm" DECIMAL(20,8),
    "cpp" DECIMAL(20,8),
    "ctr" DECIMAL(20,8),
    "frequency" DECIMAL(20,8),
    "objective" TEXT,
    "optimizationGoal" TEXT,
    "attributionSetting" TEXT,
    "productRetailerId" TEXT,
    "productGroupRetailerId" TEXT,
    "breakdownHash" TEXT,
    "breakdownJson" JSONB,
    "rawJson" JSONB,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MetaInsightDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaInsightAction" (
    "id" UUID NOT NULL,
    "actionKey" TEXT NOT NULL,
    "insightId" UUID NOT NULL,
    "kind" "MetaInsightActionKind" NOT NULL,
    "actionType" TEXT NOT NULL,
    "value" DECIMAL(30,10) NOT NULL,
    "attributionWindow" TEXT,
    "metadata" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MetaInsightAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "MetaAdAccount_storeId_metaAccountId_key" ON "MetaAdAccount"("storeId", "metaAccountId");

-- CreateIndex
CREATE INDEX "MetaAdAccount_metaConnectionId_idx" ON "MetaAdAccount"("metaConnectionId");

-- CreateIndex
CREATE UNIQUE INDEX "MetaCampaign_adAccountId_metaCampaignId_key" ON "MetaCampaign"("adAccountId", "metaCampaignId");

-- CreateIndex
CREATE INDEX "MetaCampaign_adAccountId_effectiveStatus_idx" ON "MetaCampaign"("adAccountId", "effectiveStatus");

-- CreateIndex
CREATE INDEX "MetaCampaign_deletedAt_idx" ON "MetaCampaign"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MetaAdSet_adAccountId_metaAdSetId_key" ON "MetaAdSet"("adAccountId", "metaAdSetId");

-- CreateIndex
CREATE INDEX "MetaAdSet_campaignId_effectiveStatus_idx" ON "MetaAdSet"("campaignId", "effectiveStatus");

-- CreateIndex
CREATE INDEX "MetaAdSet_deletedAt_idx" ON "MetaAdSet"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MetaCreative_adAccountId_metaCreativeId_key" ON "MetaCreative"("adAccountId", "metaCreativeId");

-- CreateIndex
CREATE INDEX "MetaCreative_productSetId_idx" ON "MetaCreative"("productSetId");

-- CreateIndex
CREATE INDEX "MetaCreative_deletedAt_idx" ON "MetaCreative"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MetaAd_adAccountId_metaAdId_key" ON "MetaAd"("adAccountId", "metaAdId");

-- CreateIndex
CREATE INDEX "MetaAd_adSetId_effectiveStatus_idx" ON "MetaAd"("adSetId", "effectiveStatus");

-- CreateIndex
CREATE INDEX "MetaAd_creativeId_idx" ON "MetaAd"("creativeId");

-- CreateIndex
CREATE INDEX "MetaAd_deletedAt_idx" ON "MetaAd"("deletedAt");

-- CreateIndex
CREATE UNIQUE INDEX "MetaProductCatalog_storeId_metaCatalogId_key" ON "MetaProductCatalog"("storeId", "metaCatalogId");

-- CreateIndex
CREATE INDEX "MetaProductCatalog_metaConnectionId_idx" ON "MetaProductCatalog"("metaConnectionId");

-- CreateIndex
CREATE UNIQUE INDEX "MetaCatalogItem_catalogId_metaProductItemId_key" ON "MetaCatalogItem"("catalogId", "metaProductItemId");

-- CreateIndex
CREATE INDEX "MetaCatalogItem_catalogId_retailerId_idx" ON "MetaCatalogItem"("catalogId", "retailerId");

-- CreateIndex
CREATE INDEX "MetaCatalogItem_retailerProductGroupId_idx" ON "MetaCatalogItem"("retailerProductGroupId");

-- CreateIndex
CREATE INDEX "MetaCatalogItem_deletedAt_idx" ON "MetaCatalogItem"("deletedAt");

-- CreateIndex
CREATE INDEX "CatalogItemVariantMapping_catalogItemId_validUntil_idx" ON "CatalogItemVariantMapping"("catalogItemId", "validUntil");

-- CreateIndex
CREATE INDEX "CatalogItemVariantMapping_variantId_validUntil_idx" ON "CatalogItemVariantMapping"("variantId", "validUntil");

-- CreateIndex
CREATE INDEX "AdProductMapping_metaAdId_validUntil_idx" ON "AdProductMapping"("metaAdId", "validUntil");

-- CreateIndex
CREATE INDEX "AdProductMapping_productId_validUntil_idx" ON "AdProductMapping"("productId", "validUntil");

-- CreateIndex
CREATE INDEX "AdProductMapping_variantId_validUntil_idx" ON "AdProductMapping"("variantId", "validUntil");

-- CreateIndex
CREATE INDEX "AdProductMapping_source_confidence_idx" ON "AdProductMapping"("source", "confidence");

-- CreateIndex
CREATE UNIQUE INDEX "MetaInsightDaily_insightKey_key" ON "MetaInsightDaily"("insightKey");

-- CreateIndex
CREATE INDEX "MetaInsightDaily_adAccountId_date_level_idx" ON "MetaInsightDaily"("adAccountId", "date", "level");

-- CreateIndex
CREATE INDEX "MetaInsightDaily_campaignId_date_idx" ON "MetaInsightDaily"("campaignId", "date");

-- CreateIndex
CREATE INDEX "MetaInsightDaily_adSetId_date_idx" ON "MetaInsightDaily"("adSetId", "date");

-- CreateIndex
CREATE INDEX "MetaInsightDaily_adId_date_idx" ON "MetaInsightDaily"("adId", "date");

-- CreateIndex
CREATE INDEX "MetaInsightDaily_productRetailerId_date_idx" ON "MetaInsightDaily"("productRetailerId", "date");

-- CreateIndex
CREATE UNIQUE INDEX "MetaInsightAction_actionKey_key" ON "MetaInsightAction"("actionKey");

-- CreateIndex
CREATE INDEX "MetaInsightAction_insightId_kind_actionType_idx" ON "MetaInsightAction"("insightId", "kind", "actionType");

-- AddForeignKey
ALTER TABLE "MetaAdAccount" ADD CONSTRAINT "MetaAdAccount_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaAdAccount" ADD CONSTRAINT "MetaAdAccount_metaConnectionId_fkey" FOREIGN KEY ("metaConnectionId") REFERENCES "MetaConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaCampaign" ADD CONSTRAINT "MetaCampaign_adAccountId_fkey" FOREIGN KEY ("adAccountId") REFERENCES "MetaAdAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaAdSet" ADD CONSTRAINT "MetaAdSet_adAccountId_fkey" FOREIGN KEY ("adAccountId") REFERENCES "MetaAdAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaAdSet" ADD CONSTRAINT "MetaAdSet_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MetaCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaCreative" ADD CONSTRAINT "MetaCreative_adAccountId_fkey" FOREIGN KEY ("adAccountId") REFERENCES "MetaAdAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaAd" ADD CONSTRAINT "MetaAd_adAccountId_fkey" FOREIGN KEY ("adAccountId") REFERENCES "MetaAdAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaAd" ADD CONSTRAINT "MetaAd_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MetaCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaAd" ADD CONSTRAINT "MetaAd_adSetId_fkey" FOREIGN KEY ("adSetId") REFERENCES "MetaAdSet"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaAd" ADD CONSTRAINT "MetaAd_creativeId_fkey" FOREIGN KEY ("creativeId") REFERENCES "MetaCreative"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaProductCatalog" ADD CONSTRAINT "MetaProductCatalog_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaProductCatalog" ADD CONSTRAINT "MetaProductCatalog_metaConnectionId_fkey" FOREIGN KEY ("metaConnectionId") REFERENCES "MetaConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaCatalogItem" ADD CONSTRAINT "MetaCatalogItem_catalogId_fkey" FOREIGN KEY ("catalogId") REFERENCES "MetaProductCatalog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogItemVariantMapping" ADD CONSTRAINT "CatalogItemVariantMapping_catalogItemId_fkey" FOREIGN KEY ("catalogItemId") REFERENCES "MetaCatalogItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CatalogItemVariantMapping" ADD CONSTRAINT "CatalogItemVariantMapping_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdProductMapping" ADD CONSTRAINT "AdProductMapping_metaAdId_fkey" FOREIGN KEY ("metaAdId") REFERENCES "MetaAd"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdProductMapping" ADD CONSTRAINT "AdProductMapping_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdProductMapping" ADD CONSTRAINT "AdProductMapping_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaInsightDaily" ADD CONSTRAINT "MetaInsightDaily_adAccountId_fkey" FOREIGN KEY ("adAccountId") REFERENCES "MetaAdAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaInsightDaily" ADD CONSTRAINT "MetaInsightDaily_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "MetaCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaInsightDaily" ADD CONSTRAINT "MetaInsightDaily_adSetId_fkey" FOREIGN KEY ("adSetId") REFERENCES "MetaAdSet"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaInsightDaily" ADD CONSTRAINT "MetaInsightDaily_adId_fkey" FOREIGN KEY ("adId") REFERENCES "MetaAd"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaInsightAction" ADD CONSTRAINT "MetaInsightAction_insightId_fkey" FOREIGN KEY ("insightId") REFERENCES "MetaInsightDaily"("id") ON DELETE CASCADE ON UPDATE CASCADE;
