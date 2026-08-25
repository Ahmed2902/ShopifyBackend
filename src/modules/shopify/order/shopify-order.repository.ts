import type { Prisma } from '../../../generated/prisma/client.js';
import { prisma } from '../../../lib/prisma.js';
import type {
  ShopifyOrderLineItem,
  ShopifyRefund,
} from './shopify-order.schema.js';
import type {
  PersistedShopifyOrder,
  ShopifyImportedOrder,
} from './shopify-order.types.js';

function optionalDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

function moneyAmount(
  value: { shopMoney: { amount: string } } | null | undefined,
): string | null {
  return value?.shopMoney.amount ?? null;
}

function asJson(value: unknown): Prisma.InputJsonValue {
  return value as Prisma.InputJsonValue;
}

export class ShopifyOrderRepository {
  async upsertOrderWithLineItems(
    storeId: string,
    order: ShopifyImportedOrder,
  ): Promise<PersistedShopifyOrder> {
    return prisma.$transaction(async (tx) => {
      const savedOrder = await tx.order.upsert({
        where: {
          storeId_shopifyOrderId: {
            storeId,
            shopifyOrderId: order.id,
          },
        },
        create: {
          storeId,
          ...this.orderData(order),
        },
        update: this.orderData(order),
        select: { id: true },
      });

      const productIds = this.uniqueIds(order.lineItems, (line) => line.product?.id);
      const variantIds = this.uniqueIds(order.lineItems, (line) => line.variant?.id);
      const lineItemIds = order.lineItems.map((lineItem) => lineItem.id);
      const [products, variants, existingLineItems] = await Promise.all([
        productIds.length
          ? tx.product.findMany({
              where: { storeId, shopifyProductId: { in: productIds } },
              select: { id: true, shopifyProductId: true },
            })
          : [],
        variantIds.length
          ? tx.productVariant.findMany({
              where: { storeId, shopifyVariantId: { in: variantIds } },
              select: { id: true, shopifyVariantId: true },
            })
          : [],
        lineItemIds.length
          ? tx.orderLineItem.findMany({
              where: { orderId: savedOrder.id, shopifyLineItemId: { in: lineItemIds } },
              select: { id: true, shopifyLineItemId: true },
            })
          : [],
      ]);

      const productMap = new Map(products.map((product) => [product.shopifyProductId, product.id]));
      const variantMap = new Map(variants.map((variant) => [variant.shopifyVariantId, variant.id]));
      const existingMap = new Map(
        existingLineItems.map((lineItem) => [lineItem.shopifyLineItemId, lineItem.id]),
      );
      const rows = order.lineItems.map((lineItem) => {
        const shopifyProductId = lineItem.product?.id ?? null;
        const shopifyVariantId = lineItem.variant?.id ?? null;
        return {
          lineItem,
          data: this.lineItemData(
            lineItem,
            shopifyProductId ? (productMap.get(shopifyProductId) ?? null) : null,
            shopifyVariantId ? (variantMap.get(shopifyVariantId) ?? null) : null,
          ),
        };
      });

      const newRows = rows.filter((row) => !existingMap.has(row.lineItem.id));
      if (newRows.length > 0) {
        await tx.orderLineItem.createMany({
          data: newRows.map((row) => ({
            orderId: savedOrder.id,
            shopifyLineItemId: row.lineItem.id,
            ...row.data,
          })),
          skipDuplicates: true,
        });
      }

      // Reconciliation updates are normally a small set. Keep different row values explicit
      // rather than introducing raw SQL solely to collapse these updates.
      for (const row of rows) {
        const id = existingMap.get(row.lineItem.id);
        if (!id) continue;
        await tx.orderLineItem.update({
          where: { id },
          data: row.data,
          select: { id: true },
        });
      }

      const persistedLineItems = lineItemIds.length
        ? await tx.orderLineItem.findMany({
            where: { orderId: savedOrder.id, shopifyLineItemId: { in: lineItemIds } },
            select: { id: true, shopifyLineItemId: true },
          })
        : [];

      return { id: savedOrder.id, lineItems: persistedLineItems };
    });
  }

  async upsertRefundWithLineItems(
    storeId: string,
    order: PersistedShopifyOrder,
    refund: ShopifyRefund,
  ): Promise<boolean> {
    const lineItemMap = new Map(
      order.lineItems.map((lineItem) => [lineItem.shopifyLineItemId, lineItem.id]),
    );
    if (
      refund.refundLineItems.nodes.some(
        (lineItem) => !lineItemMap.has(lineItem.lineItem.id),
      )
    ) {
      return false;
    }

    return prisma.$transaction(async (tx) => {
      const locationIds = [
        ...new Set(
          refund.refundLineItems.nodes
            .map((lineItem) => lineItem.location?.id)
            .filter((id): id is string => Boolean(id)),
        ),
      ];
      const locations = locationIds.length
        ? await tx.location.findMany({
            where: { storeId, shopifyLocationId: { in: locationIds } },
            select: { id: true, shopifyLocationId: true },
          })
        : [];
      const locationMap = new Map(
        locations.map((location) => [location.shopifyLocationId, location.id]),
      );

      const savedRefund = await tx.refund.upsert({
        where: {
          orderId_shopifyRefundId: {
            orderId: order.id,
            shopifyRefundId: refund.id,
          },
        },
        create: {
          orderId: order.id,
          ...this.refundData(refund),
        },
        update: this.refundData(refund),
        select: { id: true },
      });

      await tx.refundLineItem.deleteMany({ where: { refundId: savedRefund.id } });
      if (refund.refundLineItems.nodes.length > 0) {
        await tx.refundLineItem.createMany({
          data: refund.refundLineItems.nodes.map((lineItem) => ({
            refundId: savedRefund.id,
            orderLineItemId: lineItemMap.get(lineItem.lineItem.id)!,
            locationId: lineItem.location?.id
              ? (locationMap.get(lineItem.location.id) ?? null)
              : null,
            shopifyRefundLineId: lineItem.id ?? null,
            quantity: lineItem.quantity,
            restocked: lineItem.restocked,
            restockType: lineItem.restockType,
            price: moneyAmount(lineItem.priceSet),
            subtotal: moneyAmount(lineItem.subtotalSet),
            tax: moneyAmount(lineItem.totalTaxSet),
            rawJson: asJson(lineItem),
          })),
        });
      }

      return true;
    });
  }

  private orderData(order: ShopifyImportedOrder) {
    return {
      shopifyOrderId: order.id,
      name: order.name,
      shopifyCreatedAt: new Date(order.createdAt),
      processedAt: optionalDate(order.processedAt),
      shopifyUpdatedAt: optionalDate(order.updatedAt),
      cancelledAt: optionalDate(order.cancelledAt),
      cancelReason: order.cancelReason ?? null,
      sourceName: order.sourceName ?? null,
      isTest: order.test,
      currencyCode: order.currencyCode,
      presentmentCurrencyCode: order.presentmentCurrencyCode ?? null,
      displayFinancialStatus: order.displayFinancialStatus ?? null,
      displayFulfillmentStatus: order.displayFulfillmentStatus ?? null,
      currentSubtotalLineItemsQuantity: order.currentSubtotalLineItemsQuantity ?? null,
      currentSubtotalAmount: moneyAmount(order.currentSubtotalPriceSet),
      currentShippingAmount: moneyAmount(order.currentShippingPriceSet),
      currentTotalDiscountsAmount: moneyAmount(order.currentTotalDiscountsSet),
      currentTotalTaxAmount: moneyAmount(order.currentTotalTaxSet),
      currentTotalAmount: moneyAmount(order.currentTotalPriceSet),
      discountCodes: order.discountCodes,
      rawJson: asJson(order),
    };
  }

  private lineItemData(
    lineItem: ShopifyOrderLineItem,
    productId: string | null,
    variantId: string | null,
  ) {
    return {
      productId,
      variantId,
      shopifyProductId: lineItem.product?.id ?? null,
      shopifyVariantId: lineItem.variant?.id ?? null,
      sku: lineItem.sku ?? null,
      title: lineItem.title,
      variantTitle: lineItem.variantTitle ?? null,
      quantity: lineItem.quantity,
      currentQuantity: lineItem.currentQuantity,
      refundableQuantity: lineItem.refundableQuantity ?? null,
      originalUnitPrice: moneyAmount(lineItem.originalUnitPriceSet),
      originalTotal: moneyAmount(lineItem.originalTotalSet),
      discountedTotal: moneyAmount(lineItem.discountedTotalSet),
      discountedUnitPriceAfterAllDiscounts: moneyAmount(
        lineItem.discountedUnitPriceAfterAllDiscountsSet,
      ),
      totalDiscount: moneyAmount(lineItem.totalDiscountSet),
      discountAllocations: asJson(lineItem.discountAllocations),
      requiresShipping: lineItem.requiresShipping,
      restockable: lineItem.restockable,
      rawJson: asJson(lineItem),
    };
  }

  private refundData(refund: ShopifyRefund) {
    return {
      shopifyRefundId: refund.id,
      shopifyCreatedAt: optionalDate(refund.createdAt),
      processedAt: optionalDate(refund.processedAt),
      shopifyUpdatedAt: optionalDate(refund.updatedAt),
      totalRefunded: moneyAmount(refund.totalRefundedSet),
      currencyCode: refund.totalRefundedSet.shopMoney.currencyCode,
      rawJson: asJson(refund),
    };
  }

  private uniqueIds<T>(
    items: T[],
    select: (item: T) => string | null | undefined,
  ): string[] {
    return [...new Set(items.map(select).filter((id): id is string => Boolean(id)))];
  }
}
