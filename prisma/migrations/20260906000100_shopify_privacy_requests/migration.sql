CREATE TABLE "ShopifyDataRequest" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "storeId" UUID NOT NULL,
  "webhookDeliveryId" UUID NOT NULL,
  "requestedOrderIds" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "exportJson" JSONB NOT NULL,
  "completedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updatedAt" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "ShopifyDataRequest_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ShopifyOrderRedaction" (
  "id" UUID NOT NULL DEFAULT gen_random_uuid(),
  "storeId" UUID NOT NULL,
  "shopifyOrderId" TEXT NOT NULL,
  "sourceWebhookDeliveryId" UUID,
  "redactedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "ShopifyOrderRedaction_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "ShopifyDataRequest_webhookDeliveryId_key"
  ON "ShopifyDataRequest"("webhookDeliveryId");

CREATE INDEX "ShopifyDataRequest_storeId_createdAt_idx"
  ON "ShopifyDataRequest"("storeId", "createdAt");

CREATE UNIQUE INDEX "ShopifyOrderRedaction_storeId_shopifyOrderId_key"
  ON "ShopifyOrderRedaction"("storeId", "shopifyOrderId");

CREATE INDEX "ShopifyOrderRedaction_storeId_redactedAt_idx"
  ON "ShopifyOrderRedaction"("storeId", "redactedAt");

ALTER TABLE "ShopifyDataRequest"
  ADD CONSTRAINT "ShopifyDataRequest_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShopifyDataRequest"
  ADD CONSTRAINT "ShopifyDataRequest_webhookDeliveryId_fkey"
  FOREIGN KEY ("webhookDeliveryId") REFERENCES "WebhookDelivery"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "ShopifyOrderRedaction"
  ADD CONSTRAINT "ShopifyOrderRedaction_storeId_fkey"
  FOREIGN KEY ("storeId") REFERENCES "Store"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
