CREATE TABLE "StorefrontConsentWithdrawal" (
    "storeId" UUID NOT NULL,
    "scopeKey" VARCHAR(137) NOT NULL,
    "revokedBefore" TIMESTAMP(3) NOT NULL,
    "retentionExpiresAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "StorefrontConsentWithdrawal_pkey" PRIMARY KEY ("storeId", "scopeKey")
);
CREATE INDEX "StorefrontConsentWithdrawal_retentionExpiresAt_idx"
ON "StorefrontConsentWithdrawal"("retentionExpiresAt");
ALTER TABLE "StorefrontConsentWithdrawal" ADD CONSTRAINT "StorefrontConsentWithdrawal_storeId_fkey"
FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShopifyConnection"
ADD COLUMN "shopifyAppInstallationId" VARCHAR(128),
ADD COLUMN "installationVerifiedAt" TIMESTAMP(3);
