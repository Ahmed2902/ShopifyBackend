ALTER TABLE "Store"
  ADD COLUMN "inventoryRestockLeadTimeDays" INTEGER NOT NULL DEFAULT 14,
  ADD COLUMN "inventoryLowStockThreshold" INTEGER NOT NULL DEFAULT 5;

ALTER TABLE "Store"
  ADD CONSTRAINT "Store_inventoryRestockLeadTimeDays_check"
    CHECK ("inventoryRestockLeadTimeDays" BETWEEN 0 AND 3650),
  ADD CONSTRAINT "Store_inventoryLowStockThreshold_check"
    CHECK ("inventoryLowStockThreshold" BETWEEN 0 AND 1000000000);
