ALTER TABLE "Order" ADD COLUMN "purchaseFacts" JSONB;
ALTER TABLE "Order" ADD COLUMN "isB2B" BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE "ConversionDelivery" ADD COLUMN "purchaseFacts" JSONB;
ALTER TABLE "Order" ADD COLUMN "recoveryEventId" UUID;
ALTER TABLE "Order" ADD COLUMN "journeyTouches" JSONB;
CREATE TABLE "ConversionDispatchBudget" (
  "storeId" UUID NOT NULL REFERENCES "Store"(id) ON DELETE CASCADE ON UPDATE CASCADE,
  provider "AdvertisingProvider" NOT NULL,
  "nextAllowedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY ("storeId", provider)
);
CREATE TABLE "ConversionProviderCircuit" (
  provider "AdvertisingProvider" PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  "blockedUntil" TIMESTAMP(3)
);

ALTER TABLE "Order" ADD COLUMN "matchEvidenceExpiresAt" TIMESTAMP(3);
CREATE INDEX "Order_matchEvidenceExpiresAt_idx" ON "Order"("matchEvidenceExpiresAt");
ALTER TABLE "ConversionDispatchBudget" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "ConversionProviderCircuit" ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE "ConversionDispatchBudget", "ConversionProviderCircuit" FROM PUBLIC;
DO $$ BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
    REVOKE ALL ON TABLE "ConversionDispatchBudget", "ConversionProviderCircuit" FROM anon;
  END IF;
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    REVOKE ALL ON TABLE "ConversionDispatchBudget", "ConversionProviderCircuit" FROM authenticated;
  END IF;
END $$;
