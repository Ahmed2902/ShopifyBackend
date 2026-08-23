-- Prepare persistence and shared integration infrastructure for TikTok Marketing API.

ALTER TYPE "IntegrationProvider" ADD VALUE IF NOT EXISTS 'TIKTOK';

CREATE TYPE "TikTokInsightLevel" AS ENUM ('ADVERTISER', 'CAMPAIGN', 'ADGROUP', 'AD');
CREATE TYPE "TikTokAdTargetScope" AS ENUM ('STORE', 'COLLECTION', 'PRODUCT', 'PRODUCT_OPTION', 'VARIANT', 'MULTI_PRODUCT', 'UNKNOWN');

CREATE TABLE "TikTokConnection" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "openId" TEXT,
    "businessCenterId" TEXT,
    "selectedAdvertiserIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "selectedCatalogIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "accessTokenCiphertext" TEXT NOT NULL,
    "accessTokenExpiresAt" TIMESTAMP(3),
    "refreshTokenCiphertext" TEXT,
    "refreshTokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "apiVersion" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TikTokConnection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TikTokConnection_storeId_key" ON "TikTokConnection"("storeId");

ALTER TABLE "SyncRun" ADD COLUMN "tiktokConnectionId" UUID;
ALTER TABLE "WebhookDelivery" ADD COLUMN "tiktokConnectionId" UUID;

CREATE INDEX "SyncRun_tiktokConnectionId_createdAt_idx" ON "SyncRun"("tiktokConnectionId", "createdAt");
CREATE INDEX "WebhookDelivery_tiktokConnectionId_receivedAt_idx" ON "WebhookDelivery"("tiktokConnectionId", "receivedAt");

CREATE TABLE "TikTokAdvertiser" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "tiktokConnectionId" UUID NOT NULL,
    "advertiserId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT,
    "currency" TEXT,
    "timezone" TEXT,
    "countryCode" TEXT,
    "industry" TEXT,
    "company" TEXT,
    "balance" DECIMAL(20,6),
    "lastSyncedAt" TIMESTAMP(3),
    "rawJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TikTokAdvertiser_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TikTokAdvertiser_storeId_advertiserId_key" ON "TikTokAdvertiser"("storeId", "advertiserId");
CREATE INDEX "TikTokAdvertiser_tiktokConnectionId_idx" ON "TikTokAdvertiser"("tiktokConnectionId");

CREATE TABLE "TikTokCampaign" (
    "id" UUID NOT NULL,
    "advertiserDbId" UUID NOT NULL,
    "tiktokCampaignId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "objectiveType" TEXT,
    "campaignType" TEXT,
    "operationStatus" TEXT,
    "secondaryStatus" TEXT,
    "budgetMode" TEXT,
    "budget" DECIMAL(20,6),
    "deepBidType" TEXT,
    "roasBid" DECIMAL(20,8),
    "isSmartPerformance" BOOLEAN,
    "tiktokCreatedAt" TIMESTAMP(3),
    "tiktokUpdatedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "rawJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TikTokCampaign_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TikTokCampaign_advertiserDbId_tiktokCampaignId_key" ON "TikTokCampaign"("advertiserDbId", "tiktokCampaignId");
CREATE INDEX "TikTokCampaign_advertiserDbId_operationStatus_idx" ON "TikTokCampaign"("advertiserDbId", "operationStatus");
CREATE INDEX "TikTokCampaign_deletedAt_idx" ON "TikTokCampaign"("deletedAt");

CREATE TABLE "TikTokAdGroup" (
    "id" UUID NOT NULL,
    "advertiserDbId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "tiktokAdGroupId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "operationStatus" TEXT,
    "secondaryStatus" TEXT,
    "placementType" TEXT,
    "placements" JSONB,
    "promotionType" TEXT,
    "optimizationGoal" TEXT,
    "optimizationEvent" TEXT,
    "billingEvent" TEXT,
    "bidType" TEXT,
    "bidPrice" DECIMAL(20,6),
    "deepBidType" TEXT,
    "roasBid" DECIMAL(20,8),
    "budgetMode" TEXT,
    "budget" DECIMAL(20,6),
    "scheduleType" TEXT,
    "scheduleStartTime" TIMESTAMP(3),
    "scheduleEndTime" TIMESTAMP(3),
    "dayparting" TEXT,
    "pixelId" TEXT,
    "catalogId" TEXT,
    "productSetId" TEXT,
    "productSource" TEXT,
    "targeting" JSONB,
    "attribution" JSONB,
    "tiktokCreatedAt" TIMESTAMP(3),
    "tiktokUpdatedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "rawJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TikTokAdGroup_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TikTokAdGroup_advertiserDbId_tiktokAdGroupId_key" ON "TikTokAdGroup"("advertiserDbId", "tiktokAdGroupId");
CREATE INDEX "TikTokAdGroup_campaignId_operationStatus_idx" ON "TikTokAdGroup"("campaignId", "operationStatus");
CREATE INDEX "TikTokAdGroup_catalogId_idx" ON "TikTokAdGroup"("catalogId");
CREATE INDEX "TikTokAdGroup_deletedAt_idx" ON "TikTokAdGroup"("deletedAt");

CREATE TABLE "TikTokAd" (
    "id" UUID NOT NULL,
    "advertiserDbId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "adGroupId" UUID NOT NULL,
    "tiktokAdId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "operationStatus" TEXT,
    "secondaryStatus" TEXT,
    "adFormat" TEXT,
    "creativeMaterialMode" TEXT,
    "identityId" TEXT,
    "identityType" TEXT,
    "sparkAdPostId" TEXT,
    "videoId" TEXT,
    "imageIds" JSONB,
    "thumbnailUrl" TEXT,
    "adText" TEXT,
    "displayName" TEXT,
    "callToAction" TEXT,
    "landingPageUrl" TEXT,
    "trackingPixelId" TEXT,
    "catalogId" TEXT,
    "productSetId" TEXT,
    "targetScope" "TikTokAdTargetScope" NOT NULL DEFAULT 'UNKNOWN',
    "targetScopeConfidence" DECIMAL(5,4),
    "targetScopeEvidence" JSONB,
    "tracking" JSONB,
    "creativeJson" JSONB,
    "tiktokCreatedAt" TIMESTAMP(3),
    "tiktokUpdatedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "rawJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TikTokAd_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TikTokAd_advertiserDbId_tiktokAdId_key" ON "TikTokAd"("advertiserDbId", "tiktokAdId");
CREATE INDEX "TikTokAd_adGroupId_operationStatus_idx" ON "TikTokAd"("adGroupId", "operationStatus");
CREATE INDEX "TikTokAd_videoId_idx" ON "TikTokAd"("videoId");
CREATE INDEX "TikTokAd_catalogId_idx" ON "TikTokAd"("catalogId");
CREATE INDEX "TikTokAd_targetScope_idx" ON "TikTokAd"("targetScope");
CREATE INDEX "TikTokAd_deletedAt_idx" ON "TikTokAd"("deletedAt");

CREATE TABLE "TikTokCatalog" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "tiktokConnectionId" UUID NOT NULL,
    "tiktokCatalogId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "businessCenterId" TEXT,
    "catalogType" TEXT,
    "vertical" TEXT,
    "region" TEXT,
    "currency" TEXT,
    "productCount" INTEGER,
    "lastSyncedAt" TIMESTAMP(3),
    "rawJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TikTokCatalog_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TikTokCatalog_storeId_tiktokCatalogId_key" ON "TikTokCatalog"("storeId", "tiktokCatalogId");
CREATE INDEX "TikTokCatalog_tiktokConnectionId_idx" ON "TikTokCatalog"("tiktokConnectionId");

CREATE TABLE "TikTokCatalogItem" (
    "id" UUID NOT NULL,
    "catalogId" UUID NOT NULL,
    "tiktokProductId" TEXT NOT NULL,
    "retailerId" TEXT,
    "itemGroupId" TEXT,
    "title" TEXT,
    "description" TEXT,
    "brand" TEXT,
    "availability" TEXT,
    "price" DECIMAL(20,6),
    "salePrice" DECIMAL(20,6),
    "currency" TEXT,
    "size" TEXT,
    "color" TEXT,
    "pattern" TEXT,
    "url" TEXT,
    "imageUrl" TEXT,
    "productType" TEXT,
    "category" TEXT,
    "customLabels" JSONB,
    "variants" JSONB,
    "videoIds" JSONB,
    "status" TEXT,
    "deletedAt" TIMESTAMP(3),
    "rawJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TikTokCatalogItem_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TikTokCatalogItem_catalogId_tiktokProductId_key" ON "TikTokCatalogItem"("catalogId", "tiktokProductId");
CREATE INDEX "TikTokCatalogItem_catalogId_retailerId_idx" ON "TikTokCatalogItem"("catalogId", "retailerId");
CREATE INDEX "TikTokCatalogItem_itemGroupId_idx" ON "TikTokCatalogItem"("itemGroupId");
CREATE INDEX "TikTokCatalogItem_deletedAt_idx" ON "TikTokCatalogItem"("deletedAt");

CREATE TABLE "TikTokCatalogItemVariantMapping" (
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
    CONSTRAINT "TikTokCatalogItemVariantMapping_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TikTokCatalogItemVariantMapping_catalogItemId_validUntil_idx" ON "TikTokCatalogItemVariantMapping"("catalogItemId", "validUntil");
CREATE INDEX "TikTokCatalogItemVariantMapping_variantId_validUntil_idx" ON "TikTokCatalogItemVariantMapping"("variantId", "validUntil");

CREATE TABLE "TikTokAdProductMapping" (
    "id" UUID NOT NULL,
    "tiktokAdId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "variantId" UUID,
    "catalogItemId" UUID,
    "granularity" "AdProductMappingGranularity" NOT NULL DEFAULT 'PRODUCT',
    "optionSelector" JSONB,
    "source" "AdProductMappingSource" NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "evidenceJson" JSONB,
    "landingUrl" TEXT,
    "providerProductId" TEXT,
    "providerProductGroupId" TEXT,
    "isMerchantConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TikTokAdProductMapping_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "TikTokAdProductMapping_tiktokAdId_validUntil_idx" ON "TikTokAdProductMapping"("tiktokAdId", "validUntil");
CREATE INDEX "TikTokAdProductMapping_productId_validUntil_idx" ON "TikTokAdProductMapping"("productId", "validUntil");
CREATE INDEX "TikTokAdProductMapping_variantId_validUntil_idx" ON "TikTokAdProductMapping"("variantId", "validUntil");
CREATE INDEX "TikTokAdProductMapping_catalogItemId_validUntil_idx" ON "TikTokAdProductMapping"("catalogItemId", "validUntil");
CREATE INDEX "TikTokAdProductMapping_granularity_source_confidence_idx" ON "TikTokAdProductMapping"("granularity", "source", "confidence");

CREATE TABLE "TikTokInsightDaily" (
    "id" UUID NOT NULL,
    "insightKey" TEXT NOT NULL,
    "advertiserDbId" UUID NOT NULL,
    "campaignId" UUID,
    "adGroupId" UUID,
    "adId" UUID,
    "level" "TikTokInsightLevel" NOT NULL,
    "date" DATE NOT NULL,
    "accountCurrency" TEXT,
    "spend" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "impressions" BIGINT NOT NULL DEFAULT 0,
    "reach" BIGINT,
    "clicks" BIGINT NOT NULL DEFAULT 0,
    "ctr" DECIMAL(20,8),
    "cpc" DECIMAL(20,8),
    "cpm" DECIMAL(20,8),
    "frequency" DECIMAL(20,8),
    "conversions" DECIMAL(20,8),
    "conversionValue" DECIMAL(20,8),
    "costPerConversion" DECIMAL(20,8),
    "roas" DECIMAL(20,8),
    "resultCount" DECIMAL(20,8),
    "costPerResult" DECIMAL(20,8),
    "videoPlayActions" BIGINT,
    "videoWatched2s" BIGINT,
    "videoWatched6s" BIGINT,
    "videoViewsP25" BIGINT,
    "videoViewsP50" BIGINT,
    "videoViewsP75" BIGINT,
    "videoViewsP100" BIGINT,
    "likes" BIGINT,
    "comments" BIGINT,
    "shares" BIGINT,
    "follows" BIGINT,
    "profileVisits" BIGINT,
    "objectiveType" TEXT,
    "optimizationGoal" TEXT,
    "attributionWindow" TEXT,
    "dimensionsJson" JSONB,
    "metricsJson" JSONB,
    "rawJson" JSONB,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "TikTokInsightDaily_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "TikTokInsightDaily_insightKey_key" ON "TikTokInsightDaily"("insightKey");
CREATE INDEX "TikTokInsightDaily_advertiserDbId_date_level_idx" ON "TikTokInsightDaily"("advertiserDbId", "date", "level");
CREATE INDEX "TikTokInsightDaily_campaignId_date_idx" ON "TikTokInsightDaily"("campaignId", "date");
CREATE INDEX "TikTokInsightDaily_adGroupId_date_idx" ON "TikTokInsightDaily"("adGroupId", "date");
CREATE INDEX "TikTokInsightDaily_adId_date_idx" ON "TikTokInsightDaily"("adId", "date");

ALTER TABLE "TikTokConnection" ADD CONSTRAINT "TikTokConnection_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_tiktokConnectionId_fkey" FOREIGN KEY ("tiktokConnectionId") REFERENCES "TikTokConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_tiktokConnectionId_fkey" FOREIGN KEY ("tiktokConnectionId") REFERENCES "TikTokConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TikTokAdvertiser" ADD CONSTRAINT "TikTokAdvertiser_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TikTokAdvertiser" ADD CONSTRAINT "TikTokAdvertiser_tiktokConnectionId_fkey" FOREIGN KEY ("tiktokConnectionId") REFERENCES "TikTokConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TikTokCampaign" ADD CONSTRAINT "TikTokCampaign_advertiserDbId_fkey" FOREIGN KEY ("advertiserDbId") REFERENCES "TikTokAdvertiser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TikTokAdGroup" ADD CONSTRAINT "TikTokAdGroup_advertiserDbId_fkey" FOREIGN KEY ("advertiserDbId") REFERENCES "TikTokAdvertiser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TikTokAdGroup" ADD CONSTRAINT "TikTokAdGroup_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "TikTokCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TikTokAd" ADD CONSTRAINT "TikTokAd_advertiserDbId_fkey" FOREIGN KEY ("advertiserDbId") REFERENCES "TikTokAdvertiser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TikTokAd" ADD CONSTRAINT "TikTokAd_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "TikTokCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TikTokAd" ADD CONSTRAINT "TikTokAd_adGroupId_fkey" FOREIGN KEY ("adGroupId") REFERENCES "TikTokAdGroup"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TikTokCatalog" ADD CONSTRAINT "TikTokCatalog_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TikTokCatalog" ADD CONSTRAINT "TikTokCatalog_tiktokConnectionId_fkey" FOREIGN KEY ("tiktokConnectionId") REFERENCES "TikTokConnection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TikTokCatalogItem" ADD CONSTRAINT "TikTokCatalogItem_catalogId_fkey" FOREIGN KEY ("catalogId") REFERENCES "TikTokCatalog"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TikTokCatalogItemVariantMapping" ADD CONSTRAINT "TikTokCatalogItemVariantMapping_catalogItemId_fkey" FOREIGN KEY ("catalogItemId") REFERENCES "TikTokCatalogItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TikTokCatalogItemVariantMapping" ADD CONSTRAINT "TikTokCatalogItemVariantMapping_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TikTokAdProductMapping" ADD CONSTRAINT "TikTokAdProductMapping_tiktokAdId_fkey" FOREIGN KEY ("tiktokAdId") REFERENCES "TikTokAd"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TikTokAdProductMapping" ADD CONSTRAINT "TikTokAdProductMapping_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TikTokAdProductMapping" ADD CONSTRAINT "TikTokAdProductMapping_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TikTokAdProductMapping" ADD CONSTRAINT "TikTokAdProductMapping_catalogItemId_fkey" FOREIGN KEY ("catalogItemId") REFERENCES "TikTokCatalogItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TikTokInsightDaily" ADD CONSTRAINT "TikTokInsightDaily_advertiserDbId_fkey" FOREIGN KEY ("advertiserDbId") REFERENCES "TikTokAdvertiser"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "TikTokInsightDaily" ADD CONSTRAINT "TikTokInsightDaily_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "TikTokCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TikTokInsightDaily" ADD CONSTRAINT "TikTokInsightDaily_adGroupId_fkey" FOREIGN KEY ("adGroupId") REFERENCES "TikTokAdGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "TikTokInsightDaily" ADD CONSTRAINT "TikTokInsightDaily_adId_fkey" FOREIGN KEY ("adId") REFERENCES "TikTokAd"("id") ON DELETE SET NULL ON UPDATE CASCADE;
