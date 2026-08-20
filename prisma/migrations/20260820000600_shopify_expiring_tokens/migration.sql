-- Add expiring Shopify offline token rotation metadata.
ALTER TABLE "ShopifyConnection"
  ADD COLUMN "accessTokenExpiresAt" TIMESTAMP(3),
  ADD COLUMN "refreshTokenCiphertext" TEXT,
  ADD COLUMN "refreshTokenExpiresAt" TIMESTAMP(3);
