CREATE TYPE "StorefrontJourneySource" AS ENUM (
  'META',
  'GOOGLE',
  'TIKTOK',
  'UTM',
  'REFERRER',
  'DIRECT',
  'UNKNOWN'
);

CREATE TYPE "StorefrontResolutionStatus" AS ENUM (
  'NONE',
  'EXACT',
  'PARTIAL',
  'UNRESOLVED',
  'CONFLICT'
);

CREATE TYPE "StorefrontOrderLinkStatus" AS ENUM (
  'NONE',
  'PENDING',
  'LINKED'
);

ALTER TABLE "StorefrontEvent"
  ADD COLUMN "shopifyCheckoutToken" VARCHAR(255),
  ADD COLUMN "shopifyOrderExternalId" VARCHAR(128);

CREATE INDEX "StorefrontEvent_storeId_shopifyOrderExternalId_idx"
  ON "StorefrontEvent"("storeId", "shopifyOrderExternalId");

CREATE TABLE "StorefrontSession" (
  "id" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "browserSessionId" VARCHAR(128) NOT NULL,
  "anonymousVisitorId" VARCHAR(128),
  "startedAt" TIMESTAMP(3) NOT NULL,
  "endedAt" TIMESTAMP(3) NOT NULL,
  "lastSourceReceivedAt" TIMESTAMP(3) NOT NULL,
  "eventCount" INTEGER NOT NULL,
  "pageViewCount" INTEGER NOT NULL DEFAULT 0,
  "productViewCount" INTEGER NOT NULL DEFAULT 0,
  "collectionViewCount" INTEGER NOT NULL DEFAULT 0,
  "searchCount" INTEGER NOT NULL DEFAULT 0,
  "addToCartCount" INTEGER NOT NULL DEFAULT 0,
  "removeFromCartCount" INTEGER NOT NULL DEFAULT 0,
  "checkoutProgressCount" INTEGER NOT NULL DEFAULT 0,
  "checkoutStartedAt" TIMESTAMP(3),
  "checkoutCompletedAt" TIMESTAMP(3),
  "shopifyCheckoutToken" VARCHAR(255),
  "shopifyOrderExternalId" VARCHAR(128),
  "orderId" UUID,
  "orderLinkStatus" "StorefrontOrderLinkStatus" NOT NULL DEFAULT 'NONE',
  "landingPageUrl" TEXT,
  "initialReferrerUrl" TEXT,
  "dataQualityFlags" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "retentionExpiresAt" TIMESTAMP(3) NOT NULL,
  "materializedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StorefrontSession_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StorefrontSessionTouch" (
  "id" UUID NOT NULL,
  "sessionId" UUID NOT NULL,
  "ordinal" INTEGER NOT NULL,
  "eventAt" TIMESTAMP(3) NOT NULL,
  "source" "StorefrontJourneySource" NOT NULL,
  "landingPageUrl" TEXT,
  "referrerUrl" TEXT,
  "utmSource" VARCHAR(255),
  "utmMedium" VARCHAR(255),
  "utmCampaign" VARCHAR(255),
  "utmContent" VARCHAR(255),
  "utmTerm" VARCHAR(255),
  "metaClickId" VARCHAR(512),
  "googleClickId" VARCHAR(512),
  "tiktokClickId" VARCHAR(512),
  "metaCampaignExternalId" VARCHAR(128),
  "metaAdSetExternalId" VARCHAR(128),
  "metaAdExternalId" VARCHAR(128),
  "metaCampaignId" UUID,
  "metaAdSetId" UUID,
  "metaAdId" UUID,
  "metaResolutionStatus" "StorefrontResolutionStatus" NOT NULL DEFAULT 'NONE',
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StorefrontSessionTouch_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StorefrontSessionProduct" (
  "id" UUID NOT NULL,
  "sessionId" UUID NOT NULL,
  "identityKey" VARCHAR(300) NOT NULL,
  "shopifyProductExternalId" VARCHAR(128),
  "shopifyVariantExternalId" VARCHAR(128),
  "productId" UUID,
  "variantId" UUID,
  "resolutionStatus" "StorefrontResolutionStatus" NOT NULL DEFAULT 'NONE',
  "viewCount" INTEGER NOT NULL DEFAULT 0,
  "addToCartCount" INTEGER NOT NULL DEFAULT 0,
  "removeFromCartCount" INTEGER NOT NULL DEFAULT 0,
  "firstSeenAt" TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StorefrontSessionProduct_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "StorefrontSessionCollection" (
  "id" UUID NOT NULL,
  "sessionId" UUID NOT NULL,
  "shopifyCollectionExternalId" VARCHAR(128) NOT NULL,
  "collectionId" UUID,
  "resolutionStatus" "StorefrontResolutionStatus" NOT NULL DEFAULT 'NONE',
  "viewCount" INTEGER NOT NULL DEFAULT 0,
  "firstSeenAt" TIMESTAMP(3) NOT NULL,
  "lastSeenAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "StorefrontSessionCollection_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StorefrontSession_storeId_browserSessionId_key"
  ON "StorefrontSession"("storeId", "browserSessionId");
CREATE INDEX "StorefrontSession_storeId_startedAt_idx"
  ON "StorefrontSession"("storeId", "startedAt");
CREATE INDEX "StorefrontSession_storeId_anonymousVisitorId_startedAt_idx"
  ON "StorefrontSession"("storeId", "anonymousVisitorId", "startedAt");
CREATE INDEX "StorefrontSession_storeId_orderLinkStatus_checkoutCompleted_idx"
  ON "StorefrontSession"("storeId", "orderLinkStatus", "checkoutCompletedAt");
CREATE INDEX "StorefrontSession_orderId_idx"
  ON "StorefrontSession"("orderId");
CREATE INDEX "StorefrontSession_retentionExpiresAt_idx"
  ON "StorefrontSession"("retentionExpiresAt");

CREATE UNIQUE INDEX "StorefrontSessionTouch_sessionId_ordinal_key"
  ON "StorefrontSessionTouch"("sessionId", "ordinal");
CREATE INDEX "StorefrontSessionTouch_metaAdId_eventAt_idx"
  ON "StorefrontSessionTouch"("metaAdId", "eventAt");
CREATE INDEX "StorefrontSessionTouch_metaAdSetId_eventAt_idx"
  ON "StorefrontSessionTouch"("metaAdSetId", "eventAt");
CREATE INDEX "StorefrontSessionTouch_metaCampaignId_eventAt_idx"
  ON "StorefrontSessionTouch"("metaCampaignId", "eventAt");
CREATE INDEX "StorefrontSessionTouch_source_eventAt_idx"
  ON "StorefrontSessionTouch"("source", "eventAt");

CREATE UNIQUE INDEX "StorefrontSessionProduct_sessionId_identityKey_key"
  ON "StorefrontSessionProduct"("sessionId", "identityKey");
CREATE INDEX "StorefrontSessionProduct_productId_firstSeenAt_idx"
  ON "StorefrontSessionProduct"("productId", "firstSeenAt");
CREATE INDEX "StorefrontSessionProduct_variantId_firstSeenAt_idx"
  ON "StorefrontSessionProduct"("variantId", "firstSeenAt");

CREATE UNIQUE INDEX "StorefrontSessionCollection_sessionId_shopifyCollectionExte_key"
  ON "StorefrontSessionCollection"("sessionId", "shopifyCollectionExternalId");
CREATE INDEX "StorefrontSessionCollection_collectionId_firstSeenAt_idx"
  ON "StorefrontSessionCollection"("collectionId", "firstSeenAt");

ALTER TABLE "StorefrontSession"
  ADD CONSTRAINT "StorefrontSession_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StorefrontSessionTouch"
  ADD CONSTRAINT "StorefrontSessionTouch_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "StorefrontSession"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StorefrontSessionProduct"
  ADD CONSTRAINT "StorefrontSessionProduct_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "StorefrontSession"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "StorefrontSessionCollection"
  ADD CONSTRAINT "StorefrontSessionCollection_sessionId_fkey"
  FOREIGN KEY ("sessionId") REFERENCES "StorefrontSession"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
