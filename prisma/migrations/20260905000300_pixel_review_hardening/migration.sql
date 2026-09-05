ALTER TYPE "PixelInstallationStatus" ADD VALUE IF NOT EXISTS 'PROVISIONING';

ALTER TABLE "PixelInstallation"
  ADD COLUMN "pendingCollectorTokenHash" VARCHAR(64),
  ADD COLUMN "pendingCollectorTokenPrefix" VARCHAR(12);

ALTER TABLE "StorefrontSession"
  ADD COLUMN "orderLinkAttemptCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "orderLinkNextAttemptAt" TIMESTAMP(3),
  ADD COLUMN "rollupDirtyAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ADD COLUMN "behaviorRolledUpAt" TIMESTAMP(3),
  ADD COLUMN "behaviorRolledStartedAt" TIMESTAMP(3),
  ADD COLUMN "attributionRolledUpAt" TIMESTAMP(3),
  ADD COLUMN "attributionRolledStartedAt" TIMESTAMP(3);

CREATE TABLE "StorefrontSessionRepair" (
  "id" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "browserSessionId" VARCHAR(128) NOT NULL,
  "sourceReceivedAt" TIMESTAMP(3) NOT NULL,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "StorefrontSessionRepair_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StorefrontSessionRepair_store_session_key"
  ON "StorefrontSessionRepair"("storeId", "browserSessionId");
CREATE INDEX "StorefrontSessionRepair_source_id_idx"
  ON "StorefrontSessionRepair"("sourceReceivedAt", "id");

-- Preserve any raw-event backlog that existed before the explicit repair queue was introduced.
-- The deterministic UUID is only an internal row key; correctness is enforced by the unique
-- (storeId, browserSessionId) constraint.
INSERT INTO "StorefrontSessionRepair"
  ("id", "storeId", "browserSessionId", "sourceReceivedAt", "createdAt", "updatedAt")
SELECT
  md5(e."storeId"::text || ':' || e."sessionId")::uuid,
  e."storeId",
  e."sessionId",
  MAX(e."receivedAt"),
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "StorefrontEvent" e
LEFT JOIN "StorefrontSession" s
  ON s."storeId" = e."storeId"
 AND s."browserSessionId" = e."sessionId"
WHERE e."sessionId" IS NOT NULL
  AND (s."id" IS NULL OR e."receivedAt" > s."lastSourceReceivedAt")
GROUP BY e."storeId", e."sessionId"
ON CONFLICT ("storeId", "browserSessionId")
DO UPDATE SET
  "sourceReceivedAt" = GREATEST("StorefrontSessionRepair"."sourceReceivedAt", EXCLUDED."sourceReceivedAt"),
  "updatedAt" = CURRENT_TIMESTAMP;

CREATE INDEX "StorefrontEvent_storeId_sessionId_receivedAt_idx"
  ON "StorefrontEvent"("storeId", "sessionId", "receivedAt");

-- Source-domain invalidation works from compact materialized evidence rather than rescanning the
-- retained raw-event table for every Meta/catalog source mutation.
CREATE INDEX "StorefrontSessionTouch_meta_ad_external_idx"
  ON "StorefrontSessionTouch"("metaAdExternalId", "eventAt");
CREATE INDEX "StorefrontSessionTouch_meta_adset_external_idx"
  ON "StorefrontSessionTouch"("metaAdSetExternalId", "eventAt");
CREATE INDEX "StorefrontSessionTouch_meta_campaign_external_idx"
  ON "StorefrontSessionTouch"("metaCampaignExternalId", "eventAt");
CREATE INDEX "StorefrontSessionProduct_product_external_idx"
  ON "StorefrontSessionProduct"("shopifyProductExternalId", "firstSeenAt");
CREATE INDEX "StorefrontSessionProduct_variant_external_idx"
  ON "StorefrontSessionProduct"("shopifyVariantExternalId", "firstSeenAt");
CREATE INDEX "StorefrontSessionCollection_external_idx"
  ON "StorefrontSessionCollection"("shopifyCollectionExternalId", "firstSeenAt");

DROP INDEX IF EXISTS "StorefrontSession_storeId_orderLinkStatus_checkoutCompleted_idx";
CREATE INDEX "StorefrontSession_order_retry_idx"
  ON "StorefrontSession"("storeId", "orderLinkStatus", "orderLinkNextAttemptAt", "checkoutCompletedAt");
CREATE INDEX "StorefrontSession_rollup_dirty_idx"
  ON "StorefrontSession"("storeId", "rollupDirtyAt", "id");

ALTER TABLE "StorefrontSessionRepair"
  ADD CONSTRAINT "StorefrontSessionRepair_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
