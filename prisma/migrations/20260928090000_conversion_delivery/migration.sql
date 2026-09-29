CREATE TYPE "ConversionDestinationStatus" AS ENUM ('ACTIVE', 'DISABLED');
CREATE TYPE "ConversionDeliveryStatus" AS ENUM ('PENDING', 'PROCESSING', 'RETRY', 'DELIVERED', 'DEAD', 'SKIPPED');

CREATE TABLE "ConversionDestination" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "provider" "AdvertisingProvider" NOT NULL,
    "externalId" TEXT NOT NULL,
    "displayName" TEXT,
    "accessTokenCiphertext" TEXT,
    "configJson" JSONB,
    "status" "ConversionDestinationStatus" NOT NULL DEFAULT 'ACTIVE',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ConversionDestination_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ConversionDelivery" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "destinationId" UUID NOT NULL,
    "provider" "AdvertisingProvider" NOT NULL,
    "eventKey" TEXT NOT NULL,
    "eventName" TEXT NOT NULL,
    "sourceOrderId" UUID NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "eventAt" TIMESTAMP(3) NOT NULL,
    "value" DECIMAL(20,6) NOT NULL,
    "currencyCode" TEXT NOT NULL,
    "clickId" VARCHAR(512),
    "attributionEventAt" TIMESTAMP(3),
    "eventSourceUrl" TEXT,
    "status" "ConversionDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processingStartedAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "providerRequestId" TEXT,
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ConversionDelivery_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ConversionDestination_storeId_provider_externalId_key" ON "ConversionDestination"("storeId", "provider", "externalId");
CREATE INDEX "ConversionDestination_storeId_provider_status_idx" ON "ConversionDestination"("storeId", "provider", "status");
CREATE UNIQUE INDEX "ConversionDelivery_destinationId_eventKey_key" ON "ConversionDelivery"("destinationId", "eventKey");
CREATE INDEX "ConversionDelivery_status_nextAttemptAt_createdAt_idx" ON "ConversionDelivery"("status", "nextAttemptAt", "createdAt");
CREATE INDEX "ConversionDelivery_storeId_provider_createdAt_idx" ON "ConversionDelivery"("storeId", "provider", "createdAt");
CREATE INDEX "ConversionDelivery_sourceOrderId_idx" ON "ConversionDelivery"("sourceOrderId");

ALTER TABLE "ConversionDestination" ADD CONSTRAINT "ConversionDestination_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversionDelivery" ADD CONSTRAINT "ConversionDelivery_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ConversionDelivery" ADD CONSTRAINT "ConversionDelivery_destinationId_fkey" FOREIGN KEY ("destinationId") REFERENCES "ConversionDestination"("id") ON DELETE CASCADE ON UPDATE CASCADE;
