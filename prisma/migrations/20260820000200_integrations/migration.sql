-- Initial integrations schema.

-- CreateEnum
CREATE TYPE "IntegrationProvider" AS ENUM ('SHOPIFY', 'META');

-- CreateEnum
CREATE TYPE "ConnectionStatus" AS ENUM ('ACTIVE', 'REAUTH_REQUIRED', 'DISCONNECTED', 'UNINSTALLED');

-- CreateEnum
CREATE TYPE "SyncStatus" AS ENUM ('PENDING', 'RUNNING', 'SUCCEEDED', 'FAILED', 'PARTIAL');

-- CreateEnum
CREATE TYPE "WebhookStatus" AS ENUM ('RECEIVED', 'QUEUED', 'PROCESSING', 'PROCESSED', 'FAILED', 'IGNORED');

-- CreateTable
CREATE TABLE "ShopifyConnection" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "accessTokenCiphertext" TEXT NOT NULL,
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "apiVersion" TEXT NOT NULL,
    "installedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "uninstalledAt" TIMESTAMP(3),
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "ShopifyConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MetaConnection" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "status" "ConnectionStatus" NOT NULL DEFAULT 'ACTIVE',
    "metaUserId" TEXT,
    "metaBusinessId" TEXT,
    "accessTokenCiphertext" TEXT NOT NULL,
    "tokenExpiresAt" TIMESTAMP(3),
    "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "apiVersion" TEXT NOT NULL,
    "lastSyncedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "MetaConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SyncRun" (
    "id" UUID NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "shopifyConnectionId" UUID,
    "metaConnectionId" UUID,
    "resourceType" TEXT NOT NULL,
    "mode" TEXT,
    "apiVersion" TEXT NOT NULL,
    "status" "SyncStatus" NOT NULL DEFAULT 'PENDING',
    "cursor" TEXT,
    "recordsRead" INTEGER NOT NULL DEFAULT 0,
    "recordsWritten" INTEGER NOT NULL DEFAULT 0,
    "startedAt" TIMESTAMP(3),
    "finishedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SyncRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" UUID NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "externalDeliveryId" TEXT NOT NULL,
    "shopifyConnectionId" UUID,
    "metaConnectionId" UUID,
    "topic" TEXT NOT NULL,
    "apiVersion" TEXT,
    "triggeredAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "processedAt" TIMESTAMP(3),
    "status" "WebhookStatus" NOT NULL DEFAULT 'RECEIVED',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "payload" JSONB NOT NULL,
    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ExternalPayload" (
    "id" UUID NOT NULL,
    "provider" "IntegrationProvider" NOT NULL,
    "resourceType" TEXT NOT NULL,
    "externalId" TEXT,
    "apiVersion" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "receivedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "syncRunId" UUID,
    "webhookDeliveryId" UUID,
    CONSTRAINT "ExternalPayload_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "ShopifyConnection_storeId_key" ON "ShopifyConnection"("storeId");

-- CreateIndex
CREATE UNIQUE INDEX "MetaConnection_storeId_key" ON "MetaConnection"("storeId");

-- CreateIndex
CREATE INDEX "SyncRun_provider_resourceType_createdAt_idx" ON "SyncRun"("provider", "resourceType", "createdAt");

-- CreateIndex
CREATE INDEX "SyncRun_shopifyConnectionId_createdAt_idx" ON "SyncRun"("shopifyConnectionId", "createdAt");

-- CreateIndex
CREATE INDEX "SyncRun_metaConnectionId_createdAt_idx" ON "SyncRun"("metaConnectionId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_provider_externalDeliveryId_key" ON "WebhookDelivery"("provider", "externalDeliveryId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_provider_topic_receivedAt_idx" ON "WebhookDelivery"("provider", "topic", "receivedAt");

-- CreateIndex
CREATE INDEX "ExternalPayload_provider_resourceType_receivedAt_idx" ON "ExternalPayload"("provider", "resourceType", "receivedAt");

-- CreateIndex
CREATE INDEX "ExternalPayload_externalId_idx" ON "ExternalPayload"("externalId");

-- AddForeignKey
ALTER TABLE "ShopifyConnection" ADD CONSTRAINT "ShopifyConnection_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MetaConnection" ADD CONSTRAINT "MetaConnection_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_shopifyConnectionId_fkey" FOREIGN KEY ("shopifyConnectionId") REFERENCES "ShopifyConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SyncRun" ADD CONSTRAINT "SyncRun_metaConnectionId_fkey" FOREIGN KEY ("metaConnectionId") REFERENCES "MetaConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_shopifyConnectionId_fkey" FOREIGN KEY ("shopifyConnectionId") REFERENCES "ShopifyConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_metaConnectionId_fkey" FOREIGN KEY ("metaConnectionId") REFERENCES "MetaConnection"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalPayload" ADD CONSTRAINT "ExternalPayload_syncRunId_fkey" FOREIGN KEY ("syncRunId") REFERENCES "SyncRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExternalPayload" ADD CONSTRAINT "ExternalPayload_webhookDeliveryId_fkey" FOREIGN KEY ("webhookDeliveryId") REFERENCES "WebhookDelivery"("id") ON DELETE SET NULL ON UPDATE CASCADE;
