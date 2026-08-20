-- Shopify Refund.createdAt is nullable in the Admin GraphQL contract.
ALTER TABLE "Refund"
  ALTER COLUMN "shopifyCreatedAt" DROP NOT NULL;
