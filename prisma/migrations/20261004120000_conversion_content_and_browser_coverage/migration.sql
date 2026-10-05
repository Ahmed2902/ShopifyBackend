ALTER TABLE "StorefrontEvent" ADD COLUMN "commerceItems" JSONB,
  ADD COLUMN "commerceCurrencyCode" VARCHAR(3);
ALTER TABLE "ConversionDelivery" ADD COLUMN "contentCoverage" JSONB,
  ADD COLUMN "browserDispatchedAt" TIMESTAMP(3), ADD COLUMN "browserReasonCode" VARCHAR(64);
