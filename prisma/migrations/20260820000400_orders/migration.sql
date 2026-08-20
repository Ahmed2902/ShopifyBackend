-- Initial orders schema.

-- CreateEnum
CREATE TYPE "RestockSource" AS ENUM ('MANUAL', 'IMPORTED');

-- CreateEnum
CREATE TYPE "RestockStatus" AS ENUM ('PLANNED', 'ORDERED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED');

-- CreateTable
CREATE TABLE "Order" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "shopifyOrderId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "shopifyCreatedAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3),
    "shopifyUpdatedAt" TIMESTAMP(3),
    "cancelledAt" TIMESTAMP(3),
    "cancelReason" TEXT,
    "currencyCode" TEXT NOT NULL,
    "presentmentCurrencyCode" TEXT,
    "displayFinancialStatus" TEXT,
    "displayFulfillmentStatus" TEXT,
    "currentSubtotalLineItemsQuantity" INTEGER,
    "currentSubtotalAmount" DECIMAL(20,6),
    "currentShippingAmount" DECIMAL(20,6),
    "currentTotalDiscountsAmount" DECIMAL(20,6),
    "currentTotalTaxAmount" DECIMAL(20,6),
    "currentTotalAmount" DECIMAL(20,6),
    "discountCodes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
    "rawJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Order_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OrderLineItem" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "productId" UUID,
    "variantId" UUID,
    "shopifyLineItemId" TEXT NOT NULL,
    "shopifyProductId" TEXT,
    "shopifyVariantId" TEXT,
    "sku" TEXT,
    "title" TEXT NOT NULL,
    "variantTitle" TEXT,
    "quantity" INTEGER NOT NULL,
    "currentQuantity" INTEGER NOT NULL,
    "refundableQuantity" INTEGER,
    "originalUnitPrice" DECIMAL(20,6),
    "originalTotal" DECIMAL(20,6),
    "discountedTotal" DECIMAL(20,6),
    "discountedUnitPriceAfterAllDiscounts" DECIMAL(20,6),
    "totalDiscount" DECIMAL(20,6),
    "discountAllocations" JSONB,
    "requiresShipping" BOOLEAN NOT NULL DEFAULT true,
    "restockable" BOOLEAN NOT NULL DEFAULT false,
    "rawJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "OrderLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Refund" (
    "id" UUID NOT NULL,
    "orderId" UUID NOT NULL,
    "shopifyRefundId" TEXT NOT NULL,
    "shopifyCreatedAt" TIMESTAMP(3) NOT NULL,
    "processedAt" TIMESTAMP(3),
    "shopifyUpdatedAt" TIMESTAMP(3),
    "totalRefunded" DECIMAL(20,6),
    "currencyCode" TEXT,
    "rawJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Refund_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RefundLineItem" (
    "id" UUID NOT NULL,
    "refundId" UUID NOT NULL,
    "orderLineItemId" UUID NOT NULL,
    "locationId" UUID,
    "shopifyRefundLineId" TEXT,
    "quantity" INTEGER NOT NULL,
    "restocked" BOOLEAN NOT NULL DEFAULT false,
    "restockType" TEXT,
    "price" DECIMAL(20,6),
    "subtotal" DECIMAL(20,6),
    "tax" DECIMAL(20,6),
    "rawJson" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    CONSTRAINT "RefundLineItem_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Restock" (
    "id" UUID NOT NULL,
    "storeId" UUID NOT NULL,
    "source" "RestockSource" NOT NULL DEFAULT 'MANUAL',
    "status" "RestockStatus" NOT NULL DEFAULT 'PLANNED',
    "externalReference" TEXT,
    "supplierName" TEXT,
    "orderedAt" TIMESTAMP(3),
    "expectedAt" TIMESTAMP(3),
    "receivedAt" TIMESTAMP(3),
    "notes" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "Restock_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RestockLine" (
    "id" UUID NOT NULL,
    "restockId" UUID NOT NULL,
    "variantId" UUID NOT NULL,
    "quantityExpected" INTEGER NOT NULL,
    "quantityReceived" INTEGER NOT NULL DEFAULT 0,
    CONSTRAINT "RestockLine_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Order_storeId_shopifyOrderId_key" ON "Order"("storeId", "shopifyOrderId");

-- CreateIndex
CREATE INDEX "Order_storeId_shopifyCreatedAt_idx" ON "Order"("storeId", "shopifyCreatedAt");

-- CreateIndex
CREATE INDEX "Order_storeId_cancelledAt_idx" ON "Order"("storeId", "cancelledAt");

-- CreateIndex
CREATE UNIQUE INDEX "OrderLineItem_orderId_shopifyLineItemId_key" ON "OrderLineItem"("orderId", "shopifyLineItemId");

-- CreateIndex
CREATE INDEX "OrderLineItem_variantId_orderId_idx" ON "OrderLineItem"("variantId", "orderId");

-- CreateIndex
CREATE INDEX "OrderLineItem_shopifyVariantId_idx" ON "OrderLineItem"("shopifyVariantId");

-- CreateIndex
CREATE UNIQUE INDEX "Refund_orderId_shopifyRefundId_key" ON "Refund"("orderId", "shopifyRefundId");

-- CreateIndex
CREATE INDEX "Refund_orderId_shopifyCreatedAt_idx" ON "Refund"("orderId", "shopifyCreatedAt");

-- CreateIndex
CREATE INDEX "RefundLineItem_refundId_idx" ON "RefundLineItem"("refundId");

-- CreateIndex
CREATE INDEX "RefundLineItem_orderLineItemId_idx" ON "RefundLineItem"("orderLineItemId");

-- CreateIndex
CREATE INDEX "RefundLineItem_locationId_idx" ON "RefundLineItem"("locationId");

-- CreateIndex
CREATE INDEX "Restock_storeId_status_expectedAt_idx" ON "Restock"("storeId", "status", "expectedAt");

-- CreateIndex
CREATE UNIQUE INDEX "RestockLine_restockId_variantId_key" ON "RestockLine"("restockId", "variantId");

-- CreateIndex
CREATE INDEX "RestockLine_variantId_idx" ON "RestockLine"("variantId");

-- AddForeignKey
ALTER TABLE "Order" ADD CONSTRAINT "Order_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_productId_fkey" FOREIGN KEY ("productId") REFERENCES "Product"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OrderLineItem" ADD CONSTRAINT "OrderLineItem_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Refund" ADD CONSTRAINT "Refund_orderId_fkey" FOREIGN KEY ("orderId") REFERENCES "Order"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundLineItem" ADD CONSTRAINT "RefundLineItem_refundId_fkey" FOREIGN KEY ("refundId") REFERENCES "Refund"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundLineItem" ADD CONSTRAINT "RefundLineItem_orderLineItemId_fkey" FOREIGN KEY ("orderLineItemId") REFERENCES "OrderLineItem"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RefundLineItem" ADD CONSTRAINT "RefundLineItem_locationId_fkey" FOREIGN KEY ("locationId") REFERENCES "Location"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Restock" ADD CONSTRAINT "Restock_storeId_fkey" FOREIGN KEY ("storeId") REFERENCES "Store"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestockLine" ADD CONSTRAINT "RestockLine_restockId_fkey" FOREIGN KEY ("restockId") REFERENCES "Restock"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RestockLine" ADD CONSTRAINT "RestockLine_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "ProductVariant"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
