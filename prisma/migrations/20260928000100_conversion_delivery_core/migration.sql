CREATE TYPE "ConversionProvider" AS ENUM ('META', 'TIKTOK', 'GOOGLE_ADS');
CREATE TYPE "ConversionDestinationStatus" AS ENUM ('ACTIVE', 'PAUSED', 'ERROR');
CREATE TYPE "ConversionDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'RETRYING', 'SENT', 'DEAD');
CREATE TYPE "ConversionMatchKeyKind" AS ENUM ('FBC', 'TTCLID', 'GCLID', 'GBRAID', 'WBRAID');

CREATE TABLE "ConversionDestination" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "provider" "ConversionProvider" NOT NULL,
    "accountExternalId" VARCHAR(128) NOT NULL,
    "destinationExternalId" VARCHAR(256) NOT NULL,
    "secretCiphertext" TEXT,
    "status" "ConversionDestinationStatus" NOT NULL DEFAULT 'PAUSED',
    "activeFrom" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "testEventCode" VARCHAR(128),
    "lastErrorCode" VARCHAR(128),
    "lastError" TEXT,
    "lastDeliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ConversionDestination_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ConversionDelivery" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "destinationId" UUID NOT NULL,
    "sourceOrderId" UUID NOT NULL,
    "eventKey" VARCHAR(256) NOT NULL,
    "providerEventId" VARCHAR(256) NOT NULL,
    "eventAt" TIMESTAMP(3) NOT NULL,
    "sourceEventAt" TIMESTAMP(3) NOT NULL,
    "value" DECIMAL(20,6) NOT NULL,
    "currencyCode" VARCHAR(3) NOT NULL,
    "sourceUrl" TEXT NOT NULL,
    "matchKeyKind" "ConversionMatchKeyKind" NOT NULL,
    "matchKeyCiphertext" TEXT NOT NULL,
    "consentState" "StorefrontConsentState" NOT NULL,
    "status" "ConversionDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processingStartedAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "providerRequestId" VARCHAR(256),
    "lastErrorCode" VARCHAR(128),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ConversionDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConversionDestination_store_provider_account_key"
    ON "ConversionDestination"("storeId", "provider", "accountExternalId");
CREATE INDEX "ConversionDestination_store_status_idx"
    ON "ConversionDestination"("storeId", "status");

CREATE UNIQUE INDEX "ConversionDelivery_destination_event_key"
    ON "ConversionDelivery"("destinationId", "eventKey");
CREATE INDEX "ConversionDelivery_due_idx"
    ON "ConversionDelivery"("status", "nextAttemptAt", "createdAt");
CREATE INDEX "ConversionDelivery_processing_idx"
    ON "ConversionDelivery"("processingStartedAt");
CREATE INDEX "ConversionDelivery_store_created_idx"
    ON "ConversionDelivery"("storeId", "createdAt");
CREATE INDEX "ConversionDelivery_order_idx"
    ON "ConversionDelivery"("sourceOrderId");

ALTER TABLE "ConversionDestination"
    ADD CONSTRAINT "ConversionDestination_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ConversionDelivery"
    ADD CONSTRAINT "ConversionDelivery_storeId_fkey"
    FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversionDelivery"
    ADD CONSTRAINT "ConversionDelivery_destinationId_fkey"
    FOREIGN KEY ("destinationId") REFERENCES "ConversionDestination"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversionDelivery"
    ADD CONSTRAINT "ConversionDelivery_sourceOrderId_fkey"
    FOREIGN KEY ("sourceOrderId") REFERENCES "Order"("id") ON DELETE CASCADE ON UPDATE CASCADE;
