ALTER TABLE "Store"
ADD COLUMN "inventoryRestockLeadTimeDays" INTEGER NOT NULL DEFAULT 14,
ADD COLUMN "inventoryLowStockThreshold" INTEGER NOT NULL DEFAULT 5;

ALTER TABLE "Store"
ADD CONSTRAINT "Store_inventoryRestockLeadTimeDays_check"
CHECK ("inventoryRestockLeadTimeDays" >= 0 AND "inventoryRestockLeadTimeDays" <= 365),
ADD CONSTRAINT "Store_inventoryLowStockThreshold_check"
CHECK ("inventoryLowStockThreshold" >= 0 AND "inventoryLowStockThreshold" <= 1000000);
