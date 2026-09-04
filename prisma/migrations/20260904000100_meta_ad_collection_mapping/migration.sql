CREATE TABLE "AdCollectionMapping" (
  "id" UUID NOT NULL,
  "metaAdId" UUID NOT NULL,
  "collectionId" UUID NOT NULL,
  "source" "AdProductMappingSource" NOT NULL,
  "confidence" DECIMAL(5,4) NOT NULL,
  "evidenceJson" JSONB,
  "landingUrl" TEXT,
  "isMerchantConfirmed" BOOLEAN NOT NULL DEFAULT false,
  "validFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "validUntil" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "AdCollectionMapping_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "AdCollectionMapping_metaAdId_validUntil_idx"
  ON "AdCollectionMapping"("metaAdId", "validUntil");

CREATE INDEX "AdCollectionMapping_collectionId_validUntil_idx"
  ON "AdCollectionMapping"("collectionId", "validUntil");

CREATE INDEX "AdCollectionMapping_source_confidence_idx"
  ON "AdCollectionMapping"("source", "confidence");

ALTER TABLE "AdCollectionMapping"
  ADD CONSTRAINT "AdCollectionMapping_metaAdId_fkey"
  FOREIGN KEY ("metaAdId") REFERENCES "MetaAd"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "AdCollectionMapping"
  ADD CONSTRAINT "AdCollectionMapping_collectionId_fkey"
  FOREIGN KEY ("collectionId") REFERENCES "Collection"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;
