-- Canonical paid-media persistence shared by Meta, TikTok and future providers.
-- Existing provider-native tables remain in place during the migration period. Their UUIDs are
-- preserved in the canonical hierarchy so recommendation/entity references can switch without ID churn.

CREATE TYPE "AdvertisingProvider" AS ENUM ('META', 'TIKTOK', 'GOOGLE_ADS');
CREATE TYPE "AdvertisingGroupKind" AS ENUM ('AD_SET', 'AD_GROUP');
CREATE TYPE "AdvertisingMetricLevel" AS ENUM ('ACCOUNT', 'CAMPAIGN', 'GROUP', 'AD', 'CREATIVE', 'ASSET_GROUP');
CREATE TYPE "AdvertisingTargetScope" AS ENUM ('STORE', 'COLLECTION', 'PRODUCT', 'PRODUCT_OPTION', 'VARIANT', 'MULTI_PRODUCT', 'UNKNOWN');

CREATE TABLE "AdvertisingAccount" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "provider" "AdvertisingProvider" NOT NULL,
    "providerEntityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT,
    "currency" TEXT,
    "timezone" TEXT,
    "providerData" JSONB,
    "rawJson" JSONB,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdvertisingAccount_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdvertisingCampaign" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "providerEntityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT,
    "effectiveStatus" TEXT,
    "objective" TEXT,
    "campaignType" TEXT,
    "budgetAmount" DECIMAL(20,6),
    "budgetMode" TEXT,
    "bidStrategy" TEXT,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "providerData" JSONB,
    "rawJson" JSONB,
    "providerCreatedAt" TIMESTAMP(3),
    "providerUpdatedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdvertisingCampaign_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdvertisingGroup" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "providerEntityId" TEXT NOT NULL,
    "kind" "AdvertisingGroupKind" NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT,
    "effectiveStatus" TEXT,
    "optimizationGoal" TEXT,
    "billingEvent" TEXT,
    "bidStrategy" TEXT,
    "bidAmount" DECIMAL(20,6),
    "budgetAmount" DECIMAL(20,6),
    "budgetMode" TEXT,
    "targeting" JSONB,
    "startsAt" TIMESTAMP(3),
    "endsAt" TIMESTAMP(3),
    "providerData" JSONB,
    "rawJson" JSONB,
    "providerCreatedAt" TIMESTAMP(3),
    "providerUpdatedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdvertisingGroup_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdvertisingCreative" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "providerEntityId" TEXT NOT NULL,
    "name" TEXT,
    "title" TEXT,
    "body" TEXT,
    "callToActionType" TEXT,
    "imageUrl" TEXT,
    "thumbnailUrl" TEXT,
    "videoId" TEXT,
    "linkUrl" TEXT,
    "providerData" JSONB,
    "rawJson" JSONB,
    "providerCreatedAt" TIMESTAMP(3),
    "providerUpdatedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdvertisingCreative_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdvertisingAd" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "campaignId" UUID NOT NULL,
    "groupId" UUID,
    "creativeId" UUID,
    "providerEntityId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "status" TEXT,
    "effectiveStatus" TEXT,
    "format" TEXT,
    "landingPageUrl" TEXT,
    "targetScope" "AdvertisingTargetScope" NOT NULL DEFAULT 'UNKNOWN',
    "targetScopeConfidence" DECIMAL(5,4),
    "targetScopeEvidence" JSONB,
    "providerData" JSONB,
    "rawJson" JSONB,
    "providerCreatedAt" TIMESTAMP(3),
    "providerUpdatedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdvertisingAd_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdvertisingDailyMetric" (
    "id" UUID NOT NULL,
    "metricKey" TEXT NOT NULL,
    "accountId" UUID NOT NULL,
    "campaignId" UUID,
    "groupId" UUID,
    "adId" UUID,
    "creativeIdSnapshot" UUID,
    "level" "AdvertisingMetricLevel" NOT NULL,
    "date" DATE NOT NULL,
    "currency" TEXT,
    "spend" DECIMAL(20,6) NOT NULL DEFAULT 0,
    "impressions" BIGINT NOT NULL DEFAULT 0,
    "reach" BIGINT,
    "clicks" BIGINT NOT NULL DEFAULT 0,
    "conversions" DECIMAL(20,8),
    "conversionValue" DECIMAL(20,8),
    "ctr" DECIMAL(20,8),
    "cpc" DECIMAL(20,8),
    "cpm" DECIMAL(20,8),
    "frequency" DECIMAL(20,8),
    "cpa" DECIMAL(20,8),
    "roas" DECIMAL(20,8),
    "providerMetrics" JSONB,
    "breakdownHash" TEXT,
    "breakdownJson" JSONB,
    "rawJson" JSONB,
    "syncedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdvertisingDailyMetric_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdvertisingProductMapping" (
    "id" UUID NOT NULL,
    "adId" UUID NOT NULL,
    "productId" UUID NOT NULL,
    "variantId" UUID,
    "granularity" "AdProductMappingGranularity" NOT NULL DEFAULT 'PRODUCT',
    "optionSelector" JSONB,
    "source" "AdProductMappingSource" NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "evidenceJson" JSONB,
    "landingUrl" TEXT,
    "providerProductId" TEXT,
    "providerProductGroupId" TEXT,
    "providerData" JSONB,
    "isMerchantConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdvertisingProductMapping_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "AdvertisingCollectionMapping" (
    "id" UUID NOT NULL,
    "adId" UUID NOT NULL,
    "collectionId" UUID NOT NULL,
    "source" "AdProductMappingSource" NOT NULL,
    "confidence" DECIMAL(5,4) NOT NULL,
    "evidenceJson" JSONB,
    "landingUrl" TEXT,
    "providerData" JSONB,
    "isMerchantConfirmed" BOOLEAN NOT NULL DEFAULT false,
    "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "validUntil" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "AdvertisingCollectionMapping_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "AdvertisingAccount_storeId_provider_providerEntityId_key" ON "AdvertisingAccount"("storeId", "provider", "providerEntityId");
CREATE INDEX "AdvertisingAccount_storeId_provider_idx" ON "AdvertisingAccount"("storeId", "provider");
CREATE INDEX "AdvertisingAccount_provider_status_idx" ON "AdvertisingAccount"("provider", "status");

CREATE UNIQUE INDEX "AdvertisingCampaign_accountId_providerEntityId_key" ON "AdvertisingCampaign"("accountId", "providerEntityId");
CREATE INDEX "AdvertisingCampaign_accountId_effectiveStatus_idx" ON "AdvertisingCampaign"("accountId", "effectiveStatus");
CREATE INDEX "AdvertisingCampaign_deletedAt_idx" ON "AdvertisingCampaign"("deletedAt");

CREATE UNIQUE INDEX "AdvertisingGroup_accountId_providerEntityId_key" ON "AdvertisingGroup"("accountId", "providerEntityId");
CREATE INDEX "AdvertisingGroup_campaignId_effectiveStatus_idx" ON "AdvertisingGroup"("campaignId", "effectiveStatus");
CREATE INDEX "AdvertisingGroup_accountId_kind_idx" ON "AdvertisingGroup"("accountId", "kind");
CREATE INDEX "AdvertisingGroup_deletedAt_idx" ON "AdvertisingGroup"("deletedAt");

CREATE UNIQUE INDEX "AdvertisingCreative_accountId_providerEntityId_key" ON "AdvertisingCreative"("accountId", "providerEntityId");
CREATE INDEX "AdvertisingCreative_accountId_videoId_idx" ON "AdvertisingCreative"("accountId", "videoId");
CREATE INDEX "AdvertisingCreative_deletedAt_idx" ON "AdvertisingCreative"("deletedAt");

CREATE UNIQUE INDEX "AdvertisingAd_accountId_providerEntityId_key" ON "AdvertisingAd"("accountId", "providerEntityId");
CREATE INDEX "AdvertisingAd_campaignId_idx" ON "AdvertisingAd"("campaignId");
CREATE INDEX "AdvertisingAd_groupId_effectiveStatus_idx" ON "AdvertisingAd"("groupId", "effectiveStatus");
CREATE INDEX "AdvertisingAd_creativeId_idx" ON "AdvertisingAd"("creativeId");
CREATE INDEX "AdvertisingAd_targetScope_idx" ON "AdvertisingAd"("targetScope");
CREATE INDEX "AdvertisingAd_deletedAt_idx" ON "AdvertisingAd"("deletedAt");

CREATE UNIQUE INDEX "AdvertisingDailyMetric_metricKey_key" ON "AdvertisingDailyMetric"("metricKey");
CREATE INDEX "AdvertisingDailyMetric_accountId_date_level_idx" ON "AdvertisingDailyMetric"("accountId", "date", "level");
CREATE INDEX "AdvertisingDailyMetric_campaignId_date_idx" ON "AdvertisingDailyMetric"("campaignId", "date");
CREATE INDEX "AdvertisingDailyMetric_groupId_date_idx" ON "AdvertisingDailyMetric"("groupId", "date");
CREATE INDEX "AdvertisingDailyMetric_adId_date_idx" ON "AdvertisingDailyMetric"("adId", "date");
CREATE INDEX "AdvertisingDailyMetric_creativeIdSnapshot_date_idx" ON "AdvertisingDailyMetric"("creativeIdSnapshot", "date");

CREATE INDEX "AdvertisingProductMapping_adId_validUntil_idx" ON "AdvertisingProductMapping"("adId", "validUntil");
CREATE INDEX "AdvertisingProductMapping_productId_validUntil_idx" ON "AdvertisingProductMapping"("productId", "validUntil");
CREATE INDEX "AdvertisingProductMapping_variantId_validUntil_idx" ON "AdvertisingProductMapping"("variantId", "validUntil");
CREATE INDEX "AdvertisingProductMapping_granularity_source_confidence_idx" ON "AdvertisingProductMapping"("granularity", "source", "confidence");

CREATE INDEX "AdvertisingCollectionMapping_adId_validUntil_idx" ON "AdvertisingCollectionMapping"("adId", "validUntil");
CREATE INDEX "AdvertisingCollectionMapping_collectionId_validUntil_idx" ON "AdvertisingCollectionMapping"("collectionId", "validUntil");
CREATE INDEX "AdvertisingCollectionMapping_source_confidence_idx" ON "AdvertisingCollectionMapping"("source", "confidence");

ALTER TABLE "AdvertisingAccount" ADD CONSTRAINT "AdvertisingAccount_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdvertisingCampaign" ADD CONSTRAINT "AdvertisingCampaign_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "AdvertisingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdvertisingGroup" ADD CONSTRAINT "AdvertisingGroup_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "AdvertisingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdvertisingGroup" ADD CONSTRAINT "AdvertisingGroup_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "AdvertisingCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdvertisingCreative" ADD CONSTRAINT "AdvertisingCreative_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "AdvertisingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdvertisingAd" ADD CONSTRAINT "AdvertisingAd_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "AdvertisingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdvertisingAd" ADD CONSTRAINT "AdvertisingAd_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "AdvertisingCampaign"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdvertisingAd" ADD CONSTRAINT "AdvertisingAd_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "AdvertisingGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdvertisingAd" ADD CONSTRAINT "AdvertisingAd_creativeId_fkey" FOREIGN KEY ("creativeId") REFERENCES "AdvertisingCreative"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdvertisingDailyMetric" ADD CONSTRAINT "AdvertisingDailyMetric_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "AdvertisingAccount"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdvertisingDailyMetric" ADD CONSTRAINT "AdvertisingDailyMetric_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "AdvertisingCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdvertisingDailyMetric" ADD CONSTRAINT "AdvertisingDailyMetric_groupId_fkey" FOREIGN KEY ("groupId") REFERENCES "AdvertisingGroup"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdvertisingDailyMetric" ADD CONSTRAINT "AdvertisingDailyMetric_adId_fkey" FOREIGN KEY ("adId") REFERENCES "AdvertisingAd"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdvertisingDailyMetric" ADD CONSTRAINT "AdvertisingDailyMetric_creativeIdSnapshot_fkey" FOREIGN KEY ("creativeIdSnapshot") REFERENCES "AdvertisingCreative"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "AdvertisingProductMapping" ADD CONSTRAINT "AdvertisingProductMapping_adId_fkey" FOREIGN KEY ("adId") REFERENCES "AdvertisingAd"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdvertisingProductMapping" ADD CONSTRAINT "AdvertisingProductMapping_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdvertisingProductMapping" ADD CONSTRAINT "AdvertisingProductMapping_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdvertisingCollectionMapping" ADD CONSTRAINT "AdvertisingCollectionMapping_adId_fkey" FOREIGN KEY ("adId") REFERENCES "AdvertisingAd"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "AdvertisingCollectionMapping" ADD CONSTRAINT "AdvertisingCollectionMapping_collectionId_fkey" FOREIGN KEY ("collectionId") REFERENCES "Collection"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Accounts: preserve provider-native UUIDs.
INSERT INTO "AdvertisingAccount" (
    "id", "storeId", "provider", "providerEntityId", "name", "status", "currency", "timezone",
    "providerData", "rawJson", "lastSyncedAt", "createdAt", "updatedAt"
)
SELECT
    a."id", a."storeId", 'META'::"AdvertisingProvider", a."metaAccountId", a."name", a."status",
    a."currency", a."timezoneName",
    jsonb_build_object(
      'timezoneId', a."timezoneId",
      'timezoneOffsetHours', a."timezoneOffsetHours",
      'amountSpentMinor', a."amountSpentMinor",
      'balanceMinor', a."balanceMinor",
      'spendCapMinor', a."spendCapMinor"
    ),
    a."rawJson", a."lastSyncedAt", a."createdAt", a."updatedAt"
FROM "MetaAdAccount" a;

INSERT INTO "AdvertisingAccount" (
    "id", "storeId", "provider", "providerEntityId", "name", "status", "currency", "timezone",
    "providerData", "rawJson", "lastSyncedAt", "createdAt", "updatedAt"
)
SELECT
    a."id", a."storeId", 'TIKTOK'::"AdvertisingProvider", a."advertiserId", a."name", a."status",
    a."currency", a."timezone",
    jsonb_build_object(
      'countryCode', a."countryCode",
      'industry', a."industry",
      'company', a."company",
      'balance', a."balance"
    ),
    a."rawJson", a."lastSyncedAt", a."createdAt", a."updatedAt"
FROM "TikTokAdvertiser" a;

-- Campaigns. Meta budget values remain in providerData because the API stores currency minor units;
-- budgetAmount is populated only when a provider adapter can safely normalize to major currency units.
INSERT INTO "AdvertisingCampaign" (
    "id", "accountId", "providerEntityId", "name", "status", "effectiveStatus", "objective",
    "campaignType", "budgetAmount", "budgetMode", "bidStrategy", "startsAt", "endsAt",
    "providerData", "rawJson", "providerCreatedAt", "providerUpdatedAt", "deletedAt", "createdAt", "updatedAt"
)
SELECT
    c."id", c."adAccountId", c."metaCampaignId", c."name", c."configuredStatus", c."effectiveStatus",
    c."objective", c."buyingType", NULL, NULL, c."bidStrategy", c."startTime", c."stopTime",
    jsonb_build_object(
      'status', c."status",
      'dailyBudgetMinor', c."dailyBudgetMinor",
      'lifetimeBudgetMinor', c."lifetimeBudgetMinor",
      'budgetRemainingMinor', c."budgetRemainingMinor",
      'spendCapMinor', c."spendCapMinor",
      'promotedObject', c."promotedObject"
    ),
    c."rawJson", c."metaCreatedAt", c."metaUpdatedAt", c."deletedAt", c."createdAt", c."updatedAt"
FROM "MetaCampaign" c;

INSERT INTO "AdvertisingCampaign" (
    "id", "accountId", "providerEntityId", "name", "status", "effectiveStatus", "objective",
    "campaignType", "budgetAmount", "budgetMode", "bidStrategy", "startsAt", "endsAt",
    "providerData", "rawJson", "providerCreatedAt", "providerUpdatedAt", "deletedAt", "createdAt", "updatedAt"
)
SELECT
    c."id", c."advertiserDbId", c."tiktokCampaignId", c."name", c."operationStatus", c."secondaryStatus",
    c."objectiveType", c."campaignType", c."budget", c."budgetMode", c."deepBidType", NULL, NULL,
    jsonb_build_object('roasBid', c."roasBid", 'isSmartPerformance', c."isSmartPerformance"),
    c."rawJson", c."tiktokCreatedAt", c."tiktokUpdatedAt", c."deletedAt", c."createdAt", c."updatedAt"
FROM "TikTokCampaign" c;

-- Delivery groups: Meta Ad Sets and TikTok Ad Groups share one canonical relation.
INSERT INTO "AdvertisingGroup" (
    "id", "accountId", "campaignId", "providerEntityId", "kind", "name", "status", "effectiveStatus",
    "optimizationGoal", "billingEvent", "bidStrategy", "bidAmount", "budgetAmount", "budgetMode", "targeting",
    "startsAt", "endsAt", "providerData", "rawJson", "providerCreatedAt", "providerUpdatedAt", "deletedAt", "createdAt", "updatedAt"
)
SELECT
    g."id", g."adAccountId", g."campaignId", g."metaAdSetId", 'AD_SET'::"AdvertisingGroupKind", g."name",
    g."configuredStatus", g."effectiveStatus", g."optimizationGoal", g."billingEvent", g."bidStrategy", NULL, NULL, NULL,
    g."targeting", g."startTime", g."endTime",
    jsonb_build_object(
      'status', g."status",
      'dailyBudgetMinor', g."dailyBudgetMinor",
      'lifetimeBudgetMinor', g."lifetimeBudgetMinor",
      'budgetRemainingMinor', g."budgetRemainingMinor",
      'dailySpendCapMinor', g."dailySpendCapMinor",
      'lifetimeSpendCapMinor', g."lifetimeSpendCapMinor",
      'bidAmountMinor', g."bidAmountMinor",
      'bidConstraints', g."bidConstraints",
      'destinationType', g."destinationType",
      'isDynamicCreative', g."isDynamicCreative",
      'promotedObject', g."promotedObject",
      'attributionSpec', g."attributionSpec",
      'learningStageInfo', g."learningStageInfo"
    ),
    g."rawJson", g."metaCreatedAt", g."metaUpdatedAt", g."deletedAt", g."createdAt", g."updatedAt"
FROM "MetaAdSet" g;

INSERT INTO "AdvertisingGroup" (
    "id", "accountId", "campaignId", "providerEntityId", "kind", "name", "status", "effectiveStatus",
    "optimizationGoal", "billingEvent", "bidStrategy", "bidAmount", "budgetAmount", "budgetMode", "targeting",
    "startsAt", "endsAt", "providerData", "rawJson", "providerCreatedAt", "providerUpdatedAt", "deletedAt", "createdAt", "updatedAt"
)
SELECT
    g."id", g."advertiserDbId", g."campaignId", g."tiktokAdGroupId", 'AD_GROUP'::"AdvertisingGroupKind", g."name",
    g."operationStatus", g."secondaryStatus", g."optimizationGoal", g."billingEvent", g."bidType", g."bidPrice", g."budget", g."budgetMode",
    g."targeting", g."scheduleStartTime", g."scheduleEndTime",
    jsonb_build_object(
      'placementType', g."placementType",
      'placements', g."placements",
      'promotionType', g."promotionType",
      'optimizationEvent', g."optimizationEvent",
      'deepBidType', g."deepBidType",
      'roasBid', g."roasBid",
      'scheduleType', g."scheduleType",
      'dayparting', g."dayparting",
      'pixelId', g."pixelId",
      'catalogId', g."catalogId",
      'productSetId', g."productSetId",
      'productSource', g."productSource",
      'attribution', g."attribution"
    ),
    g."rawJson", g."tiktokCreatedAt", g."tiktokUpdatedAt", g."deletedAt", g."createdAt", g."updatedAt"
FROM "TikTokAdGroup" g;

-- Meta has a stable first-class creative entity. TikTok creative material remains on the canonical ad
-- until a stable reusable creative identity is available.
INSERT INTO "AdvertisingCreative" (
    "id", "accountId", "providerEntityId", "name", "title", "body", "callToActionType", "imageUrl",
    "thumbnailUrl", "videoId", "linkUrl", "providerData", "rawJson", "providerCreatedAt", "providerUpdatedAt",
    "deletedAt", "createdAt", "updatedAt"
)
SELECT
    c."id", c."adAccountId", c."metaCreativeId", c."name", c."title", c."body", c."callToActionType",
    c."imageUrl", c."thumbnailUrl", c."videoId", COALESCE(c."linkUrl", c."objectUrl"),
    jsonb_build_object(
      'callToAction', c."callToAction",
      'linkDeepLinkUrl', c."linkDeepLinkUrl",
      'objectUrl', c."objectUrl",
      'objectStoryId', c."objectStoryId",
      'effectiveObjectStoryId', c."effectiveObjectStoryId",
      'effectiveInstagramMediaId', c."effectiveInstagramMediaId",
      'objectStorySpec', c."objectStorySpec",
      'productSetId', c."productSetId",
      'productData', c."productData",
      'assetFeedSpec', c."assetFeedSpec",
      'degreesOfFreedomSpec', c."degreesOfFreedomSpec",
      'resolvedDestinationUrls', c."resolvedDestinationUrls",
      'templateUrl', c."templateUrl",
      'templateUrlSpec', c."templateUrlSpec",
      'urlTags', c."urlTags",
      'instagramPermalinkUrl', c."instagramPermalinkUrl"
    ),
    c."rawJson", c."metaCreatedAt", c."metaUpdatedAt", c."deletedAt", c."createdAt", c."updatedAt"
FROM "MetaCreative" c;

INSERT INTO "AdvertisingAd" (
    "id", "accountId", "campaignId", "groupId", "creativeId", "providerEntityId", "name", "status", "effectiveStatus",
    "format", "landingPageUrl", "targetScope", "targetScopeConfidence", "targetScopeEvidence", "providerData", "rawJson",
    "providerCreatedAt", "providerUpdatedAt", "deletedAt", "createdAt", "updatedAt"
)
SELECT
    a."id", a."adAccountId", a."campaignId", a."adSetId", a."creativeId", a."metaAdId", a."name",
    a."configuredStatus", a."effectiveStatus", NULL, c."linkUrl",
    a."targetScope"::text::"AdvertisingTargetScope", a."targetScopeConfidence", a."targetScopeEvidence",
    jsonb_build_object(
      'conversionDomain', a."conversionDomain",
      'sourceAdId', a."sourceAdId",
      'placement', a."placement",
      'trackingSpec', a."trackingSpec",
      'conversionSpec', a."conversionSpec",
      'recommendations', a."recommendations",
      'issuesInfo', a."issuesInfo",
      'adLabels', a."adLabels"
    ),
    a."rawJson", a."metaCreatedAt", a."metaUpdatedAt", a."deletedAt", a."createdAt", a."updatedAt"
FROM "MetaAd" a
LEFT JOIN "MetaCreative" c ON c."id" = a."creativeId";

INSERT INTO "AdvertisingAd" (
    "id", "accountId", "campaignId", "groupId", "creativeId", "providerEntityId", "name", "status", "effectiveStatus",
    "format", "landingPageUrl", "targetScope", "targetScopeConfidence", "targetScopeEvidence", "providerData", "rawJson",
    "providerCreatedAt", "providerUpdatedAt", "deletedAt", "createdAt", "updatedAt"
)
SELECT
    a."id", a."advertiserDbId", a."campaignId", a."adGroupId", NULL, a."tiktokAdId", a."name",
    a."operationStatus", a."secondaryStatus", a."adFormat", a."landingPageUrl",
    a."targetScope"::text::"AdvertisingTargetScope", a."targetScopeConfidence", a."targetScopeEvidence",
    jsonb_build_object(
      'creativeMaterialMode', a."creativeMaterialMode",
      'identityId', a."identityId",
      'identityType', a."identityType",
      'sparkAdPostId', a."sparkAdPostId",
      'videoId', a."videoId",
      'imageIds', a."imageIds",
      'thumbnailUrl', a."thumbnailUrl",
      'adText', a."adText",
      'displayName', a."displayName",
      'callToAction', a."callToAction",
      'trackingPixelId', a."trackingPixelId",
      'catalogId', a."catalogId",
      'productSetId', a."productSetId",
      'tracking', a."tracking",
      'creativeJson', a."creativeJson"
    ),
    a."rawJson", a."tiktokCreatedAt", a."tiktokUpdatedAt", a."deletedAt", a."createdAt", a."updatedAt"
FROM "TikTokAd" a;

-- Common daily facts are backfilled immediately. Meta purchase normalization still lives in the
-- existing action rows during this additive phase, so scalar conversions/value remain null for Meta
-- until the canonical writer derives the same purchase semantics during dual-write.
INSERT INTO "AdvertisingDailyMetric" (
    "id", "metricKey", "accountId", "campaignId", "groupId", "adId", "creativeIdSnapshot", "level", "date",
    "currency", "spend", "impressions", "reach", "clicks", "conversions", "conversionValue", "ctr", "cpc", "cpm",
    "frequency", "cpa", "roas", "providerMetrics", "breakdownHash", "breakdownJson", "rawJson", "syncedAt", "createdAt", "updatedAt"
)
SELECT
    i."id", 'META:' || i."insightKey", i."adAccountId", i."campaignId", i."adSetId", i."adId", i."creativeIdSnapshot",
    CASE i."level"::text
      WHEN 'ACCOUNT' THEN 'ACCOUNT'::"AdvertisingMetricLevel"
      WHEN 'CAMPAIGN' THEN 'CAMPAIGN'::"AdvertisingMetricLevel"
      WHEN 'ADSET' THEN 'GROUP'::"AdvertisingMetricLevel"
      ELSE 'AD'::"AdvertisingMetricLevel"
    END,
    i."date", i."accountCurrency", i."spend", i."impressions", i."reach", i."clicks", NULL, NULL,
    i."ctr", i."cpc", i."cpm", i."frequency", NULL, NULL,
    jsonb_build_object(
      'socialSpend', i."socialSpend",
      'uniqueClicks', i."uniqueClicks",
      'outboundClicks', i."outboundClicks",
      'uniqueOutboundClicks', i."uniqueOutboundClicks",
      'inlineLinkClicks', i."inlineLinkClicks",
      'inlinePostEngagement', i."inlinePostEngagement",
      'estimatedAdRecallers', i."estimatedAdRecallers",
      'estimatedAdRecallRate', i."estimatedAdRecallRate",
      'cpp', i."cpp",
      'objective', i."objective",
      'optimizationGoal', i."optimizationGoal",
      'attributionSetting', i."attributionSetting",
      'actionReportTime', i."actionReportTime",
      'productIdBreakdown', i."productIdBreakdown",
      'productGroupIdBreakdown', i."productGroupIdBreakdown",
      'productRetailerId', i."productRetailerId",
      'productGroupRetailerId', i."productGroupRetailerId",
      'websiteCtr', i."websiteCtr",
      'conversions', i."conversions",
      'conversionValues', i."conversionValues",
      'videoMetrics', i."videoMetrics"
    ),
    i."breakdownHash", i."breakdownJson", i."rawJson", i."syncedAt", i."createdAt", i."updatedAt"
FROM "MetaInsightDaily" i;

INSERT INTO "AdvertisingDailyMetric" (
    "id", "metricKey", "accountId", "campaignId", "groupId", "adId", "creativeIdSnapshot", "level", "date",
    "currency", "spend", "impressions", "reach", "clicks", "conversions", "conversionValue", "ctr", "cpc", "cpm",
    "frequency", "cpa", "roas", "providerMetrics", "breakdownHash", "breakdownJson", "rawJson", "syncedAt", "createdAt", "updatedAt"
)
SELECT
    i."id", 'TIKTOK:' || i."insightKey", i."advertiserDbId", i."campaignId", i."adGroupId", i."adId", NULL,
    CASE i."level"::text
      WHEN 'ADVERTISER' THEN 'ACCOUNT'::"AdvertisingMetricLevel"
      WHEN 'CAMPAIGN' THEN 'CAMPAIGN'::"AdvertisingMetricLevel"
      WHEN 'ADGROUP' THEN 'GROUP'::"AdvertisingMetricLevel"
      ELSE 'AD'::"AdvertisingMetricLevel"
    END,
    i."date", i."accountCurrency", i."spend", i."impressions", i."reach", i."clicks", i."conversions", i."conversionValue",
    i."ctr", i."cpc", i."cpm", i."frequency", i."costPerConversion", i."roas",
    jsonb_build_object(
      'resultCount', i."resultCount",
      'costPerResult', i."costPerResult",
      'videoPlayActions', i."videoPlayActions",
      'videoWatched2s', i."videoWatched2s",
      'videoWatched6s', i."videoWatched6s",
      'videoViewsP25', i."videoViewsP25",
      'videoViewsP50', i."videoViewsP50",
      'videoViewsP75', i."videoViewsP75",
      'videoViewsP100', i."videoViewsP100",
      'likes', i."likes",
      'comments', i."comments",
      'shares', i."shares",
      'follows', i."follows",
      'profileVisits', i."profileVisits",
      'objectiveType', i."objectiveType",
      'optimizationGoal', i."optimizationGoal",
      'attributionWindow', i."attributionWindow",
      'dimensions', i."dimensionsJson",
      'metrics', i."metricsJson"
    ),
    NULL, i."dimensionsJson", i."rawJson", i."syncedAt", i."createdAt", i."updatedAt"
FROM "TikTokInsightDaily" i;

INSERT INTO "AdvertisingProductMapping" (
    "id", "adId", "productId", "variantId", "granularity", "optionSelector", "source", "confidence",
    "evidenceJson", "landingUrl", "providerProductId", "providerProductGroupId", "providerData",
    "isMerchantConfirmed", "validFrom", "validUntil", "createdAt", "updatedAt"
)
SELECT
    m."id", m."metaAdId", m."productId", m."variantId", m."granularity", m."optionSelector", m."source", m."confidence",
    m."evidenceJson", m."landingUrl", m."providerProductId", m."providerProductGroupId",
    jsonb_build_object('legacyCatalogItemId', m."catalogItemId"),
    m."isMerchantConfirmed", m."validFrom", m."validUntil", m."createdAt", m."updatedAt"
FROM "AdProductMapping" m;

INSERT INTO "AdvertisingProductMapping" (
    "id", "adId", "productId", "variantId", "granularity", "optionSelector", "source", "confidence",
    "evidenceJson", "landingUrl", "providerProductId", "providerProductGroupId", "providerData",
    "isMerchantConfirmed", "validFrom", "validUntil", "createdAt", "updatedAt"
)
SELECT
    m."id", m."tiktokAdId", m."productId", m."variantId", m."granularity", m."optionSelector", m."source", m."confidence",
    m."evidenceJson", m."landingUrl", m."providerProductId", m."providerProductGroupId",
    jsonb_build_object('legacyCatalogItemId', m."catalogItemId"),
    m."isMerchantConfirmed", m."validFrom", m."validUntil", m."createdAt", m."updatedAt"
FROM "TikTokAdProductMapping" m;

INSERT INTO "AdvertisingCollectionMapping" (
    "id", "adId", "collectionId", "source", "confidence", "evidenceJson", "landingUrl", "providerData",
    "isMerchantConfirmed", "validFrom", "validUntil", "createdAt", "updatedAt"
)
SELECT
    m."id", m."metaAdId", m."collectionId", m."source", m."confidence", m."evidenceJson", m."landingUrl", NULL,
    m."isMerchantConfirmed", m."validFrom", m."validUntil", m."createdAt", m."updatedAt"
FROM "AdCollectionMapping" m;
