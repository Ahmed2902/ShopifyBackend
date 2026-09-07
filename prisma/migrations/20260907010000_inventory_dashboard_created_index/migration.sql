-- Support the Overview inventory preview's tenant-scoped newest-item selection before
-- joining inventory levels and recent sales. The existing (storeId, sku) index cannot
-- satisfy ORDER BY createdAt DESC for this access path.
CREATE INDEX "InventoryItem_storeId_createdAt_idx"
ON "InventoryItem"("storeId", "createdAt");
