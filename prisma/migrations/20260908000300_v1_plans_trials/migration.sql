CREATE TYPE "BillingPlan" AS ENUM ('ESSENTIALS', 'PRO');
CREATE TYPE "BillingStatus" AS ENUM ('TRIALING', 'ACTIVE', 'PAST_DUE', 'CANCELED', 'EXPIRED');
CREATE TYPE "BillingProvider" AS ENUM ('INTERNAL', 'SHOPIFY');

CREATE TABLE "StoreSubscription" (
  "id" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "selectedPlan" "BillingPlan" NOT NULL DEFAULT 'ESSENTIALS',
  "status" "BillingStatus" NOT NULL DEFAULT 'TRIALING',
  "provider" "BillingProvider" NOT NULL DEFAULT 'INTERNAL',
  "trialStartedAt" TIMESTAMP(3) NOT NULL,
  "trialEndsAt" TIMESTAMP(3) NOT NULL,
  "currentPeriodEndsAt" TIMESTAMP(3),
  "canceledAt" TIMESTAMP(3),
  "cancelAtEndOfCycle" BOOLEAN NOT NULL DEFAULT false,
  "shopifyAppSubscriptionId" TEXT,
  "shopifyPlanHandle" TEXT,
  "lastVerifiedAt" TIMESTAMP(3),
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "StoreSubscription_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "StoreSubscription_storeId_key" ON "StoreSubscription"("storeId");
CREATE UNIQUE INDEX "StoreSubscription_shopifyAppSubscriptionId_key" ON "StoreSubscription"("shopifyAppSubscriptionId");
CREATE INDEX "StoreSubscription_status_trialEndsAt_idx" ON "StoreSubscription"("status", "trialEndsAt");
CREATE INDEX "StoreSubscription_provider_status_idx" ON "StoreSubscription"("provider", "status");

ALTER TABLE "StoreSubscription"
  ADD CONSTRAINT "StoreSubscription_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE CASCADE ON UPDATE CASCADE;
