ALTER TABLE "Store"
  ADD COLUMN "inventoryRestockLeadTimeDays" INTEGER NOT NULL DEFAULT 14,
  ADD COLUMN "inventoryLowStockThresholdUnits" INTEGER NOT NULL DEFAULT 5;
