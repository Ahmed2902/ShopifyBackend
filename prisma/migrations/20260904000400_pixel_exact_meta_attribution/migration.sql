ALTER TABLE "StorefrontEvent"
  ADD COLUMN "metaCampaignExternalId" VARCHAR(128),
  ADD COLUMN "metaAdSetExternalId" VARCHAR(128),
  ADD COLUMN "metaAdExternalId" VARCHAR(128);

CREATE INDEX "StorefrontEvent_storeId_metaAdExternalId_eventAt_idx"
  ON "StorefrontEvent"("storeId", "metaAdExternalId", "eventAt");
