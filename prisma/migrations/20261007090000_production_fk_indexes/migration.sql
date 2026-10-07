-- Cover foreign-key maintenance paths identified in the deployed database.
CREATE INDEX "ConversionDelivery_destinationId_storeId_provider_idx" ON "ConversionDelivery"("destinationId", "storeId", "provider");
CREATE INDEX "ExternalPayload_syncRunId_idx" ON "ExternalPayload"("syncRunId");
CREATE INDEX "ExternalPayload_webhookDeliveryId_idx" ON "ExternalPayload"("webhookDeliveryId");
CREATE INDEX "InventorySnapshot_locationId_idx" ON "InventorySnapshot"("locationId");
CREATE INDEX "MetaAd_campaignId_idx" ON "MetaAd"("campaignId");
CREATE INDEX "TikTokAd_campaignId_idx" ON "TikTokAd"("campaignId");
CREATE INDEX "WebhookDelivery_metaConnectionId_idx" ON "WebhookDelivery"("metaConnectionId");
CREATE INDEX "WebhookDelivery_shopifyConnectionId_idx" ON "WebhookDelivery"("shopifyConnectionId");
