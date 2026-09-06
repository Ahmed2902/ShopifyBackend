ALTER TYPE "StorefrontEventName" ADD VALUE 'CART_VIEW';

ALTER TABLE "StorefrontSession"
  ADD COLUMN "cartViewCount" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "StorefrontBehaviorDaily"
  ADD COLUMN "cartViewCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cartViewSessionCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cartViewCheckoutSessionCount" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "cartViewPurchaseSessionCount" INTEGER NOT NULL DEFAULT 0;
