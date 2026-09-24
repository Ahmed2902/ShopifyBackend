-- Google Ads uses provider-specific connection/customer staging only. Runtime campaign, group,
-- ad, creative and metric facts remain in canonical Advertising* tables.
ALTER TYPE "BillingAdProvider" ADD VALUE IF NOT EXISTS 'GOOGLE_ADS';

CREATE TABLE "GoogleAdsConnection" (
  "id" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "status" "ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
  "selectedCustomerIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "accessTokenCiphertext" TEXT NOT NULL,
  "accessTokenExpiresAt" TIMESTAMP(3),
  "refreshTokenCiphertext" TEXT NOT NULL,
  "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "apiVersion" TEXT NOT NULL,
  "lastSyncedAt" TIMESTAMP(3),
  "lastSyncStatus" "SyncStatus",
  "lastSyncError" TEXT,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GoogleAdsConnection_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GoogleAdsConnection_storeId_key" ON "GoogleAdsConnection"("storeId");
CREATE INDEX "GoogleAdsConnection_status_idx" ON "GoogleAdsConnection"("status");
ALTER TABLE "GoogleAdsConnection" ADD CONSTRAINT "GoogleAdsConnection_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "GoogleAdsCustomer" (
  "id" UUID NOT NULL,
  "storeId" UUID NOT NULL,
  "googleAdsConnectionId" UUID NOT NULL,
  "customerId" TEXT NOT NULL,
  "loginCustomerId" TEXT,
  "descriptiveName" TEXT NOT NULL,
  "status" TEXT,
  "currencyCode" TEXT,
  "timeZone" TEXT,
  "manager" BOOLEAN NOT NULL DEFAULT false,
  "testAccount" BOOLEAN NOT NULL DEFAULT false,
  "level" INTEGER,
  "parentCustomerId" TEXT,
  "rawJson" JSONB,
  "lastDiscoveredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GoogleAdsCustomer_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GoogleAdsCustomer_storeId_customerId_key" ON "GoogleAdsCustomer"("storeId", "customerId");
CREATE INDEX "GoogleAdsCustomer_googleAdsConnectionId_idx" ON "GoogleAdsCustomer"("googleAdsConnectionId");
CREATE INDEX "GoogleAdsCustomer_storeId_manager_idx" ON "GoogleAdsCustomer"("storeId", "manager");
CREATE INDEX "GoogleAdsCustomer_loginCustomerId_idx" ON "GoogleAdsCustomer"("loginCustomerId");
ALTER TABLE "GoogleAdsCustomer" ADD CONSTRAINT "GoogleAdsCustomer_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "GoogleAdsCustomer" ADD CONSTRAINT "GoogleAdsCustomer_googleAdsConnectionId_fkey" FOREIGN KEY ("googleAdsConnectionId") REFERENCES "GoogleAdsConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "GoogleAdsSyncCheckpoint" (
  "id" UUID NOT NULL,
  "googleAdsConnectionId" UUID NOT NULL,
  "customerId" TEXT NOT NULL,
  "kind" TEXT NOT NULL,
  "windowStart" DATE NOT NULL,
  "windowEnd" DATE NOT NULL,
  "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "GoogleAdsSyncCheckpoint_pkey" PRIMARY KEY ("id")
);
CREATE UNIQUE INDEX "GoogleAdsSyncCheckpoint_googleAdsConnectionId_customerId_ki_key" ON "GoogleAdsSyncCheckpoint"("googleAdsConnectionId", "customerId", "kind", "windowStart", "windowEnd");
CREATE INDEX "GoogleAdsSyncCheckpoint_googleAdsConnectionId_kind_customer_idx" ON "GoogleAdsSyncCheckpoint"("googleAdsConnectionId", "kind", "customerId");
ALTER TABLE "GoogleAdsSyncCheckpoint" ADD CONSTRAINT "GoogleAdsSyncCheckpoint_googleAdsConnectionId_fkey" FOREIGN KEY ("googleAdsConnectionId") REFERENCES "GoogleAdsConnection"("id") ON DELETE CASCADE ON UPDATE CASCADE;
