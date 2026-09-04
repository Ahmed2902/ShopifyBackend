CREATE TYPE "StorefrontEventName" AS ENUM (
  'PAGE_VIEW',
  'PRODUCT_VIEW',
  'COLLECTION_VIEW',
  'SEARCH',
  'ADD_TO_CART',
  'REMOVE_FROM_CART',
  'BEGIN_CHECKOUT',
  'CHECKOUT_PROGRESS',
  'CHECKOUT_COMPLETED'
);

CREATE TYPE "StorefrontConsentState" AS ENUM (
  'UNKNOWN',
  'GRANTED',
  'DENIED',
  'NOT_REQUIRED'
);

CREATE TABLE "StorefrontEvent" (
  "id" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "eventId" VARCHAR(128) NOT NULL,
  "eventVersion" INTEGER NOT NULL DEFAULT 1,
  "eventName" "StorefrontEventName" NOT NULL,
  "eventAt" TIMESTAMP(3) NOT NULL,
  "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "anonymousVisitorId" VARCHAR(128),
  "sessionId" VARCHAR(128),
  "consentState" "StorefrontConsentState" NOT NULL,
  "pageUrl" TEXT,
  "referrerUrl" TEXT,
  "landingPageUrl" TEXT,
  "productExternalId" VARCHAR(128),
  "variantExternalId" VARCHAR(128),
  "collectionExternalId" VARCHAR(128),
  "quantity" INTEGER,
  "utmSource" VARCHAR(255),
  "utmMedium" VARCHAR(255),
  "utmCampaign" VARCHAR(255),
  "utmContent" VARCHAR(255),
  "utmTerm" VARCHAR(255),
  "metaClickId" VARCHAR(512),
  "googleClickId" VARCHAR(512),
  "tiktokClickId" VARCHAR(512),
  "retentionExpiresAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StorefrontEvent_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StorefrontEvent_storeId_eventId_key"
  ON "StorefrontEvent"("storeId", "eventId");

CREATE INDEX "StorefrontEvent_storeId_eventAt_idx"
  ON "StorefrontEvent"("storeId", "eventAt");

CREATE INDEX "StorefrontEvent_storeId_eventName_eventAt_idx"
  ON "StorefrontEvent"("storeId", "eventName", "eventAt");

CREATE INDEX "StorefrontEvent_storeId_anonymousVisitorId_eventAt_idx"
  ON "StorefrontEvent"("storeId", "anonymousVisitorId", "eventAt");

CREATE INDEX "StorefrontEvent_storeId_sessionId_eventAt_idx"
  ON "StorefrontEvent"("storeId", "sessionId", "eventAt");

CREATE INDEX "StorefrontEvent_retentionExpiresAt_idx"
  ON "StorefrontEvent"("retentionExpiresAt");

ALTER TABLE "StorefrontEvent"
  ADD CONSTRAINT "StorefrontEvent_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
