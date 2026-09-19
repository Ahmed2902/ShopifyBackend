ALTER TABLE "Store"
  ADD COLUMN "inventoryRestockLeadDays" INTEGER NOT NULL DEFAULT 14,
  ADD COLUMN "inventoryLowStockThreshold" INTEGER NOT NULL DEFAULT 5;

ALTER TABLE "Store"
  ADD CONSTRAINT "Store_inventoryRestockLeadDays_check"
    CHECK ("inventoryRestockLeadDays" >= 1 AND "inventoryRestockLeadDays" <= 365),
  ADD CONSTRAINT "Store_inventoryLowStockThreshold_check"
    CHECK ("inventoryLowStockThreshold" >= 0 AND "inventoryLowStockThreshold" <= 1000000);
