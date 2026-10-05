-- Atomic migration: failed uniqueness/tenant validation leaves the previous schema intact.
BEGIN;

-- AlterTable
ALTER TABLE "ConversionDelivery" ADD COLUMN     "clickIdKind" VARCHAR(16),
ADD COLUMN     "matchCoverage" JSONB,
ADD COLUMN     "reasonCode" VARCHAR(64),
ADD COLUMN     "sourceEventId" UUID,
ADD COLUMN     "sourceGenerationAt" TIMESTAMP(3),
ALTER COLUMN "sourceOrderId" DROP NOT NULL,
ALTER COLUMN "shopifyOrderId" DROP NOT NULL,
ALTER COLUMN "value" DROP NOT NULL,
ALTER COLUMN "currencyCode" DROP NOT NULL;

-- AlterTable
ALTER TABLE "StorefrontEvent" ADD COLUMN     "acquisitionBasis" VARCHAR(32),
ADD COLUMN     "acquisitionChannel" VARCHAR(32),
ADD COLUMN     "acquisitionPaid" BOOLEAN,
ADD COLUMN     "acquisitionProvider" VARCHAR(32),
ADD COLUMN     "acquisitionVersion" INTEGER,
ADD COLUMN     "browserMatchCiphertext" TEXT,
ADD COLUMN     "browserMatchExpiresAt" TIMESTAMP(3),
ADD COLUMN     "googleBraidedClickId" VARCHAR(512),
ADD COLUMN     "googleWebBraidedClickId" VARCHAR(512);

-- AlterTable
ALTER TABLE "StorefrontSessionTouch" ADD COLUMN     "acquisitionBasis" VARCHAR(32),
ADD COLUMN     "acquisitionChannel" VARCHAR(32),
ADD COLUMN     "acquisitionPaid" BOOLEAN,
ADD COLUMN     "acquisitionProvider" VARCHAR(32),
ADD COLUMN     "acquisitionVersion" INTEGER,
ADD COLUMN     "googleBraidedClickId" VARCHAR(512),
ADD COLUMN     "googleWebBraidedClickId" VARCHAR(512);

-- CreateTable
CREATE TABLE "StoreSignalIdentityKey" (
    "storeId" UUID NOT NULL,
    "secretCiphertext" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StoreSignalIdentityKey_pkey" PRIMARY KEY ("storeId")
);

-- CreateTable
CREATE TABLE "StorefrontCustomerLink" (
    "sourceOrderId" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "customerKey" VARCHAR(64) NOT NULL,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "StorefrontCustomerLink_pkey" PRIMARY KEY ("sourceOrderId")
);

-- CreateIndex
CREATE INDEX "StorefrontCustomerLink_storeId_customerKey_idx" ON "StorefrontCustomerLink"("storeId", "customerKey");

-- CreateIndex
CREATE INDEX "StorefrontCustomerLink_expiresAt_idx" ON "StorefrontCustomerLink"("expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "StorefrontCustomerLink_sourceOrderId_storeId_key" ON "StorefrontCustomerLink"("sourceOrderId", "storeId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversionDestination_id_storeId_provider_key" ON "ConversionDestination"("id", "storeId", "provider");

-- CreateIndex
CREATE INDEX "ConversionDelivery_sourceEventId_idx" ON "ConversionDelivery"("sourceEventId");

-- CreateIndex
CREATE UNIQUE INDEX "ConversionDelivery_destinationId_sourceOrderId_eventName_key" ON "ConversionDelivery"("destinationId", "sourceOrderId", "eventName");

-- CreateIndex
CREATE UNIQUE INDEX "Order_id_storeId_key" ON "Order"("id", "storeId");

-- CreateIndex
CREATE INDEX "StorefrontEvent_browserMatchExpiresAt_idx" ON "StorefrontEvent"("browserMatchExpiresAt");

-- Replace destination ownership constraint only after the referenced unique index exists.
ALTER TABLE "ConversionDelivery" DROP CONSTRAINT "ConversionDelivery_destinationId_fkey";

-- AddForeignKey
ALTER TABLE "ConversionDelivery" ADD CONSTRAINT "ConversionDelivery_destinationId_storeId_provider_fkey" FOREIGN KEY ("destinationId", "storeId", "provider") REFERENCES "ConversionDestination"("id", "storeId", "provider") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StoreSignalIdentityKey" ADD CONSTRAINT "StoreSignalIdentityKey_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorefrontCustomerLink" ADD CONSTRAINT "StorefrontCustomerLink_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "StorefrontCustomerLink" ADD CONSTRAINT "StorefrontCustomerLink_sourceOrderId_storeId_fkey" FOREIGN KEY ("sourceOrderId", "storeId") REFERENCES "Order"("id", "storeId") ON DELETE CASCADE ON UPDATE CASCADE;

-- Bound tenant diagnostics, retention scans and per-session touch-window reads.
CREATE INDEX "ConversionDelivery_storeId_createdAt_idx" ON "ConversionDelivery"("storeId", "createdAt");
CREATE INDEX "ConversionDelivery_status_eventAt_idx" ON "ConversionDelivery"("status", "eventAt");
CREATE INDEX "StorefrontSessionTouch_sessionId_eventAt_idx" ON "StorefrontSessionTouch"("sessionId", "eventAt");

COMMIT;
