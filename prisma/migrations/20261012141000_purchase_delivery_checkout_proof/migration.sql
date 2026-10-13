-- Canonical order/checkout correlation without retaining a reusable order checkout token.
ALTER TABLE "Order" ADD COLUMN "checkoutTokenHash" VARCHAR(64);
ALTER TABLE "StorefrontEvent" ADD COLUMN "checkoutTokenHash" VARCHAR(64);
CREATE INDEX "StorefrontEvent_checkout_proof_idx" ON "StorefrontEvent" ("storeId", "checkoutTokenHash", "eventAt");
-- Test-payment deliveries use the regular queue but can never be ordinary production conversions.
ALTER TABLE "ConversionDelivery" ADD COLUMN "isTestDelivery" BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE "ConversionDelivery" ADD COLUMN "testCodeCiphertext" TEXT;
ALTER TABLE "ConversionDelivery" ADD COLUMN "testExpiresAt" TIMESTAMP(3);
