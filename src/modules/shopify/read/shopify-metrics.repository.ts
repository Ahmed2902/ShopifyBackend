import { prisma } from '../../../lib/prisma.js';
import type {
  ShopifyProductSalesQuery,
  ShopifySummaryQuery,
} from './shopify-read.schema.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function decimal(value: { toString(): string } | null | undefined): string {
  return value?.toString() ?? '0';
}

function dateKey(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function resolveWindow(query: { from?: string; to?: string }) {
  const to = query.to ? new Date(query.to) : new Date();
  const from = query.from ? new Date(query.from) : new Date(to.getTime() - 30 * DAY_MS);
  return { from, to };
}

function demandDateWhere(from: Date, to: Date) {
  return {
    OR: [
      { processedAt: { gte: from, lte: to } },
      { processedAt: null, shopifyCreatedAt: { gte: from, lte: to } },
    ],
  };
}

export class ShopifyMetricsRepository {
  async getSummary(storeId: string, query: ShopifySummaryQuery) {
    const { from, to } = resolveWindow(query);
    const lowStockBelow = query.lowStockBelow ?? 5;

    const [
      products,
      variants,
      trackedInventoryItems,
      untrackedInventoryItems,
      locations,
      inventory,
      lowStockLevels,
      outOfStockLevels,
      orders,
      orderTotals,
      refunds,
    ] = await Promise.all([
      prisma.product.groupBy({
        by: ['status'],
        where: { storeId, deletedAt: null },
        _count: { _all: true },
      }),
      prisma.productVariant.count({ where: { storeId, deletedAt: null } }),
      prisma.inventoryItem.count({ where: { storeId, deletedAt: null, tracked: true } }),
      prisma.inventoryItem.count({ where: { storeId, deletedAt: null, tracked: false } }),
      prisma.location.count({ where: { storeId, deletedAt: null, isActive: true } }),
      prisma.inventoryLevelCurrent.aggregate({
        where: {
          inventoryItem: {
            storeId,
            deletedAt: null,
            tracked: true,
            variant: { deletedAt: null, product: { deletedAt: null } },
          },
          location: { storeId, deletedAt: null },
        },
        _sum: {
          available: true,
          onHand: true,
          incoming: true,
          committed: true,
          reserved: true,
          damaged: true,
          safetyStock: true,
          qualityControl: true,
        },
      }),
      prisma.inventoryLevelCurrent.count({
        where: {
          available: { gt: 0, lte: lowStockBelow },
          inventoryItem: {
            storeId,
            deletedAt: null,
            tracked: true,
            variant: { deletedAt: null, product: { deletedAt: null } },
          },
          location: { storeId, deletedAt: null },
        },
      }),
      prisma.inventoryLevelCurrent.count({
        where: {
          available: { lte: 0 },
          inventoryItem: {
            storeId,
            deletedAt: null,
            tracked: true,
            variant: { deletedAt: null, product: { deletedAt: null } },
          },
          location: { storeId, deletedAt: null },
        },
      }),
      prisma.order.count({
        where: {
          storeId,
          isTest: false,
          ...demandDateWhere(from, to),
        },
      }),
      prisma.order.aggregate({
        where: {
          storeId,
          isTest: false,
          ...demandDateWhere(from, to),
        },
        _sum: {
          currentSubtotalLineItemsQuantity: true,
          currentTotalAmount: true,
          currentTotalDiscountsAmount: true,
        },
      }),
      prisma.refund.aggregate({
        where: {
          order: {
            storeId,
            isTest: false,
            ...demandDateWhere(from, to),
          },
        },
        _sum: { totalRefunded: true },
        _count: { _all: true },
      }),
    ]);

    const statusCounts = Object.fromEntries(
      products.map((row) => [row.status, row._count._all]),
    );

    return {
      window: { from, to },
      catalog: {
        products: products.reduce((sum, row) => sum + row._count._all, 0),
        activeProducts: statusCounts.ACTIVE ?? 0,
        draftProducts: statusCounts.DRAFT ?? 0,
        archivedProducts: statusCounts.ARCHIVED ?? 0,
        variants,
        trackedInventoryItems,
        untrackedInventoryItems,
        activeLocations: locations,
      },
      inventory: {
        available: inventory._sum.available ?? 0,
        onHand: inventory._sum.onHand ?? 0,
        incoming: inventory._sum.incoming ?? 0,
        committed: inventory._sum.committed ?? 0,
        reserved: inventory._sum.reserved ?? 0,
        damaged: inventory._sum.damaged ?? 0,
        safetyStock: inventory._sum.safetyStock ?? 0,
        qualityControl: inventory._sum.qualityControl ?? 0,
        lowStockLevels,
        outOfStockLevels,
        lowStockBelow,
      },
      commerce: {
        orders,
        units: orderTotals._sum.currentSubtotalLineItemsQuantity ?? 0,
        totalSales: decimal(orderTotals._sum.currentTotalAmount),
        discounts: decimal(orderTotals._sum.currentTotalDiscountsAmount),
        refunds: refunds._count._all,
        refundedAmount: decimal(refunds._sum.totalRefunded),
      },
    };
  }

  async getProductSales(storeId: string, productId: string, query: ShopifyProductSalesQuery) {
    const { from, to } = resolveWindow(query);

    const product = await prisma.product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
      select: { id: true, title: true },
    });
    if (!product) return null;

    const rows = await prisma.orderLineItem.findMany({
      where: {
        productId,
        order: {
          storeId,
          isTest: false,
          ...demandDateWhere(from, to),
        },
      },
      orderBy: { order: { processedAt: 'asc' } },
      select: {
        quantity: true,
        currentQuantity: true,
        discountedTotal: true,
        variantId: true,
        variantTitle: true,
        sku: true,
        order: {
          select: {
            id: true,
            name: true,
            processedAt: true,
            shopifyCreatedAt: true,
            cancelledAt: true,
            currencyCode: true,
          },
        },
        refundLines: {
          select: { quantity: true, subtotal: true },
        },
      },
    });

    const variants = new Map<
      string,
      {
        variantId: string | null;
        variantTitle: string | null;
        sku: string | null;
        orderedUnits: number;
        currentUnits: number;
        refundedUnits: number;
        grossSales: number;
        refundedSales: number;
        orders: Set<string>;
      }
    >();
    const daily = new Map<
      string,
      { date: string; orderedUnits: number; currentUnits: number; grossSales: number; refundedSales: number; orders: Set<string> }
    >();
    const allOrders = new Set<string>();

    for (const row of rows) {
      const variantKey = row.variantId ?? `${row.sku ?? ''}:${row.variantTitle ?? ''}`;
      const refundedUnits = row.refundLines.reduce((sum, refund) => sum + refund.quantity, 0);
      const refundedSales = row.refundLines.reduce(
        (sum, refund) => sum + Number(refund.subtotal ?? 0),
        0,
      );
      const grossSales = Number(row.discountedTotal ?? 0);
      const existingVariant = variants.get(variantKey) ?? {
        variantId: row.variantId,
        variantTitle: row.variantTitle,
        sku: row.sku,
        orderedUnits: 0,
        currentUnits: 0,
        refundedUnits: 0,
        grossSales: 0,
        refundedSales: 0,
        orders: new Set<string>(),
      };
      existingVariant.orderedUnits += row.quantity;
      existingVariant.currentUnits += row.currentQuantity;
      existingVariant.refundedUnits += refundedUnits;
      existingVariant.grossSales += grossSales;
      existingVariant.refundedSales += refundedSales;
      existingVariant.orders.add(row.order.id);
      variants.set(variantKey, existingVariant);

      const effectiveDate = row.order.processedAt ?? row.order.shopifyCreatedAt;
      const key = dateKey(effectiveDate);
      const existingDay = daily.get(key) ?? {
        date: key,
        orderedUnits: 0,
        currentUnits: 0,
        grossSales: 0,
        refundedSales: 0,
        orders: new Set<string>(),
      };
      existingDay.orderedUnits += row.quantity;
      existingDay.currentUnits += row.currentQuantity;
      existingDay.grossSales += grossSales;
      existingDay.refundedSales += refundedSales;
      existingDay.orders.add(row.order.id);
      daily.set(key, existingDay);
      allOrders.add(row.order.id);
    }

    const variantItems = Array.from(variants.values()).map((row) => ({
      variantId: row.variantId,
      variantTitle: row.variantTitle,
      sku: row.sku,
      orderCount: row.orders.size,
      orderedUnits: row.orderedUnits,
      currentUnits: row.currentUnits,
      refundedUnits: row.refundedUnits,
      grossSales: row.grossSales.toFixed(2),
      refundedSales: row.refundedSales.toFixed(2),
      netSales: (row.grossSales - row.refundedSales).toFixed(2),
    }));
    const dailyItems = Array.from(daily.values()).map((row) => ({
      date: row.date,
      orderCount: row.orders.size,
      orderedUnits: row.orderedUnits,
      currentUnits: row.currentUnits,
      grossSales: row.grossSales.toFixed(2),
      refundedSales: row.refundedSales.toFixed(2),
      netSales: (row.grossSales - row.refundedSales).toFixed(2),
    }));

    const grossSales = variantItems.reduce((sum, row) => sum + Number(row.grossSales), 0);
    const refundedSales = variantItems.reduce((sum, row) => sum + Number(row.refundedSales), 0);

    return {
      product,
      window: { from, to },
      currencyCode: rows[0]?.order.currencyCode ?? null,
      summary: {
        orderCount: allOrders.size,
        orderedUnits: variantItems.reduce((sum, row) => sum + row.orderedUnits, 0),
        currentUnits: variantItems.reduce((sum, row) => sum + row.currentUnits, 0),
        refundedUnits: variantItems.reduce((sum, row) => sum + row.refundedUnits, 0),
        grossSales: grossSales.toFixed(2),
        refundedSales: refundedSales.toFixed(2),
        netSales: (grossSales - refundedSales).toFixed(2),
      },
      variants: variantItems,
      daily: dailyItems,
    };
  }
}
