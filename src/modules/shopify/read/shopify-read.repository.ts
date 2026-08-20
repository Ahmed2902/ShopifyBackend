import { prisma } from '../../../lib/prisma.js';
import type {
  ShopifyInventoryQuery,
  ShopifyOrdersQuery,
  ShopifyProductsQuery,
} from './shopify-read.schema.js';

function decimal(value: { toString(): string } | null): string | null {
  return value?.toString() ?? null;
}

function pageMeta(page: number, limit: number, total: number) {
  return {
    page,
    limit,
    total,
    hasMore: page * limit < total,
  };
}

export class ShopifyReadRepository {
  async getStatus(storeId: string) {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        name: true,
        myshopifyDomain: true,
        currencyCode: true,
        ianaTimezone: true,
        shopifyConnection: {
          select: {
            id: true,
            status: true,
            scopes: true,
            apiVersion: true,
            installedAt: true,
            uninstalledAt: true,
            lastSyncedAt: true,
            lastReconciledAt: true,
            nextReconciliationAt: true,
            reconciliationIntervalMinutes: true,
          },
        },
      },
    });
    if (!store) return null;

    const [products, variants, inventoryLevels, locations, orders, latestBackfill, latestReconciliation] =
      await Promise.all([
        prisma.product.count({ where: { storeId, deletedAt: null } }),
        prisma.productVariant.count({ where: { storeId, deletedAt: null } }),
        prisma.inventoryLevelCurrent.count({
          where: {
            inventoryItem: {
              storeId,
              deletedAt: null,
              variant: { deletedAt: null, product: { deletedAt: null } },
            },
            location: { storeId, deletedAt: null },
          },
        }),
        prisma.location.count({ where: { storeId, deletedAt: null } }),
        prisma.order.count({ where: { storeId } }),
        prisma.syncRun.findFirst({
          where: {
            provider: 'SHOPIFY',
            resourceType: 'OrdersRefunds',
            shopifyConnection: { is: { storeId } },
          },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            status: true,
            providerOperationId: true,
            recordsRead: true,
            recordsWritten: true,
            startedAt: true,
            finishedAt: true,
            lastError: true,
          },
        }),
        prisma.syncRun.findFirst({
          where: {
            provider: 'SHOPIFY',
            resourceType: 'StoreReconciliation',
            shopifyConnection: { is: { storeId } },
          },
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            status: true,
            recordsRead: true,
            recordsWritten: true,
            startedAt: true,
            finishedAt: true,
            lastError: true,
          },
        }),
      ]);

    return {
      store: {
        id: store.id,
        name: store.name,
        myshopifyDomain: store.myshopifyDomain,
        currencyCode: store.currencyCode,
        ianaTimezone: store.ianaTimezone,
      },
      connection: store.shopifyConnection,
      counts: { products, variants, inventoryLevels, locations, orders },
      orderHistory: latestBackfill,
      reconciliation: latestReconciliation,
    };
  }

  async listProducts(storeId: string, query: ShopifyProductsQuery) {
    const where = {
      storeId,
      deletedAt: null,
      ...(query.status ? { status: query.status } : {}),
      ...(query.vendor ? { vendor: query.vendor } : {}),
      ...(query.q
        ? {
            OR: [
              { title: { contains: query.q, mode: 'insensitive' as const } },
              { handle: { contains: query.q, mode: 'insensitive' as const } },
              { vendor: { contains: query.q, mode: 'insensitive' as const } },
              {
                variants: {
                  some: {
                    deletedAt: null,
                    sku: { contains: query.q, mode: 'insensitive' as const },
                  },
                },
              },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.product.count({ where }),
      prisma.product.findMany({
        where,
        orderBy: [{ shopifyUpdatedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          shopifyProductId: true,
          title: true,
          handle: true,
          productType: true,
          vendor: true,
          tags: true,
          status: true,
          totalInventory: true,
          tracksInventory: true,
          publishedAt: true,
          shopifyUpdatedAt: true,
          variants: {
            where: { deletedAt: null },
            select: {
              id: true,
              price: true,
              inventoryItem: {
                select: {
                  currentLevels: {
                    select: { available: true, onHand: true, incoming: true },
                  },
                },
              },
            },
          },
        },
      }),
    ]);

    const items = rows.map((product) => {
      const levels = product.variants.flatMap(
        (variant) => variant.inventoryItem?.currentLevels ?? [],
      );
      const prices = product.variants
        .map((variant) => variant.price)
        .filter((value): value is NonNullable<typeof value> => value !== null);
      return {
        id: product.id,
        shopifyProductId: product.shopifyProductId,
        title: product.title,
        handle: product.handle,
        productType: product.productType,
        vendor: product.vendor,
        tags: product.tags,
        status: product.status,
        totalInventory: product.totalInventory,
        tracksInventory: product.tracksInventory,
        publishedAt: product.publishedAt,
        shopifyUpdatedAt: product.shopifyUpdatedAt,
        variantCount: product.variants.length,
        availableInventory: levels.reduce((sum, level) => sum + level.available, 0),
        onHandInventory: levels.reduce((sum, level) => sum + level.onHand, 0),
        incomingInventory: levels.reduce((sum, level) => sum + level.incoming, 0),
        minPrice:
          prices.length > 0
            ? decimal(prices.reduce((min, value) => (value.lt(min) ? value : min)))
            : null,
        maxPrice:
          prices.length > 0
            ? decimal(prices.reduce((max, value) => (value.gt(max) ? value : max)))
            : null,
      };
    });

    return { items, ...pageMeta(query.page, query.limit, total) };
  }

  async getProduct(storeId: string, productId: string) {
    const product = await prisma.product.findFirst({
      where: { id: productId, storeId, deletedAt: null },
      select: {
        id: true,
        shopifyProductId: true,
        title: true,
        handle: true,
        productType: true,
        vendor: true,
        tags: true,
        status: true,
        totalInventory: true,
        tracksInventory: true,
        publishedAt: true,
        shopifyCreatedAt: true,
        shopifyUpdatedAt: true,
        variants: {
          where: { deletedAt: null },
          orderBy: [{ position: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            shopifyVariantId: true,
            title: true,
            displayName: true,
            sku: true,
            barcode: true,
            price: true,
            compareAtPrice: true,
            position: true,
            availableForSale: true,
            inventoryQuantity: true,
            inventoryPolicy: true,
            shopifyUpdatedAt: true,
            options: {
              orderBy: [{ position: 'asc' }, { name: 'asc' }],
              select: { name: true, value: true, position: true },
            },
            inventoryItem: {
              select: {
                id: true,
                shopifyInventoryItemId: true,
                tracked: true,
                requiresShipping: true,
                currentLevels: {
                  orderBy: { location: { name: 'asc' } },
                  select: {
                    available: true,
                    incoming: true,
                    committed: true,
                    onHand: true,
                    reserved: true,
                    damaged: true,
                    safetyStock: true,
                    qualityControl: true,
                    sourceUpdatedAt: true,
                    lastReconciledAt: true,
                    location: {
                      select: { id: true, shopifyLocationId: true, name: true, isActive: true },
                    },
                  },
                },
              },
            },
          },
        },
      },
    });
    if (!product) return null;

    return {
      ...product,
      variants: product.variants.map((variant) => ({
        ...variant,
        price: decimal(variant.price),
        compareAtPrice: decimal(variant.compareAtPrice),
      })),
    };
  }

  async listInventory(storeId: string, query: ShopifyInventoryQuery) {
    const where = {
      inventoryItem: {
        storeId,
        deletedAt: null,
        variant: {
          deletedAt: null,
          product: { deletedAt: null },
        },
      },
      location: {
        storeId,
        deletedAt: null,
        ...(query.locationId ? { id: query.locationId } : {}),
      },
      ...(query.lowStockBelow !== undefined ? { available: { lte: query.lowStockBelow } } : {}),
      ...(query.q
        ? {
            OR: [
              {
                inventoryItem: {
                  sku: { contains: query.q, mode: 'insensitive' as const },
                },
              },
              {
                inventoryItem: {
                  variant: {
                    title: { contains: query.q, mode: 'insensitive' as const },
                  },
                },
              },
              {
                inventoryItem: {
                  variant: {
                    product: {
                      title: { contains: query.q, mode: 'insensitive' as const },
                    },
                  },
                },
              },
            ],
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.inventoryLevelCurrent.count({ where }),
      prisma.inventoryLevelCurrent.findMany({
        where,
        orderBy: [{ available: 'asc' }, { id: 'asc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          available: true,
          incoming: true,
          committed: true,
          onHand: true,
          reserved: true,
          damaged: true,
          safetyStock: true,
          qualityControl: true,
          sourceUpdatedAt: true,
          lastReconciledAt: true,
          location: {
            select: { id: true, shopifyLocationId: true, name: true, isActive: true },
          },
          inventoryItem: {
            select: {
              id: true,
              shopifyInventoryItemId: true,
              sku: true,
              tracked: true,
              variant: {
                select: {
                  id: true,
                  shopifyVariantId: true,
                  title: true,
                  displayName: true,
                  sku: true,
                  price: true,
                  product: {
                    select: { id: true, shopifyProductId: true, title: true, status: true },
                  },
                },
              },
            },
          },
        },
      }),
    ]);

    const items = rows.map((row) => ({
      ...row,
      inventoryItem: {
        ...row.inventoryItem,
        variant: {
          ...row.inventoryItem.variant,
          price: decimal(row.inventoryItem.variant.price),
        },
      },
    }));
    return { items, ...pageMeta(query.page, query.limit, total) };
  }

  async listLocations(storeId: string) {
    const rows = await prisma.location.findMany({
      where: { storeId, deletedAt: null },
      orderBy: [{ isActive: 'desc' }, { name: 'asc' }],
      select: {
        id: true,
        shopifyLocationId: true,
        name: true,
        isActive: true,
        fulfillsOnlineOrders: true,
        shipsInventory: true,
        hasActiveInventory: true,
        deactivatedAt: true,
        addressJson: true,
        shopifyUpdatedAt: true,
        currentLevels: {
          select: { available: true, incoming: true, onHand: true },
        },
      },
    });

    return rows.map((location) => ({
      ...location,
      availableInventory: location.currentLevels.reduce((sum, level) => sum + level.available, 0),
      incomingInventory: location.currentLevels.reduce((sum, level) => sum + level.incoming, 0),
      onHandInventory: location.currentLevels.reduce((sum, level) => sum + level.onHand, 0),
      inventoryLevelCount: location.currentLevels.length,
      currentLevels: undefined,
    }));
  }

  async listOrders(storeId: string, query: ShopifyOrdersQuery) {
    const where = {
      storeId,
      ...(query.q ? { name: { contains: query.q, mode: 'insensitive' as const } } : {}),
      ...(query.financialStatus ? { displayFinancialStatus: query.financialStatus } : {}),
      ...(query.fulfillmentStatus ? { displayFulfillmentStatus: query.fulfillmentStatus } : {}),
      ...(query.sourceName ? { sourceName: query.sourceName } : {}),
      ...(query.isTest !== undefined ? { isTest: query.isTest } : {}),
      ...(query.from || query.to
        ? {
            shopifyCreatedAt: {
              ...(query.from ? { gte: new Date(query.from) } : {}),
              ...(query.to ? { lte: new Date(query.to) } : {}),
            },
          }
        : {}),
    };

    const [total, rows] = await Promise.all([
      prisma.order.count({ where }),
      prisma.order.findMany({
        where,
        orderBy: [{ shopifyCreatedAt: 'desc' }, { id: 'desc' }],
        skip: (query.page - 1) * query.limit,
        take: query.limit,
        select: {
          id: true,
          shopifyOrderId: true,
          name: true,
          shopifyCreatedAt: true,
          processedAt: true,
          shopifyUpdatedAt: true,
          cancelledAt: true,
          cancelReason: true,
          sourceName: true,
          isTest: true,
          currencyCode: true,
          presentmentCurrencyCode: true,
          displayFinancialStatus: true,
          displayFulfillmentStatus: true,
          currentSubtotalLineItemsQuantity: true,
          currentSubtotalAmount: true,
          currentShippingAmount: true,
          currentTotalDiscountsAmount: true,
          currentTotalTaxAmount: true,
          currentTotalAmount: true,
          discountCodes: true,
          lineItems: { select: { quantity: true, currentQuantity: true } },
          refunds: { select: { totalRefunded: true } },
        },
      }),
    ]);

    const items = rows.map((order) => ({
      id: order.id,
      shopifyOrderId: order.shopifyOrderId,
      name: order.name,
      shopifyCreatedAt: order.shopifyCreatedAt,
      processedAt: order.processedAt,
      shopifyUpdatedAt: order.shopifyUpdatedAt,
      cancelledAt: order.cancelledAt,
      cancelReason: order.cancelReason,
      sourceName: order.sourceName,
      isTest: order.isTest,
      currencyCode: order.currencyCode,
      presentmentCurrencyCode: order.presentmentCurrencyCode,
      displayFinancialStatus: order.displayFinancialStatus,
      displayFulfillmentStatus: order.displayFulfillmentStatus,
      currentSubtotalLineItemsQuantity: order.currentSubtotalLineItemsQuantity,
      currentSubtotalAmount: decimal(order.currentSubtotalAmount),
      currentShippingAmount: decimal(order.currentShippingAmount),
      currentTotalDiscountsAmount: decimal(order.currentTotalDiscountsAmount),
      currentTotalTaxAmount: decimal(order.currentTotalTaxAmount),
      currentTotalAmount: decimal(order.currentTotalAmount),
      discountCodes: order.discountCodes,
      lineItemCount: order.lineItems.length,
      orderedQuantity: order.lineItems.reduce((sum, item) => sum + item.quantity, 0),
      currentQuantity: order.lineItems.reduce((sum, item) => sum + item.currentQuantity, 0),
      refundCount: order.refunds.length,
      refundedAmount: order.refunds
        .reduce((sum, refund) => sum + Number(refund.totalRefunded ?? 0), 0)
        .toString(),
    }));

    return { items, ...pageMeta(query.page, query.limit, total) };
  }

  async getOrder(storeId: string, orderId: string) {
    const order = await prisma.order.findFirst({
      where: { id: orderId, storeId },
      select: {
        id: true,
        shopifyOrderId: true,
        name: true,
        shopifyCreatedAt: true,
        processedAt: true,
        shopifyUpdatedAt: true,
        cancelledAt: true,
        cancelReason: true,
        sourceName: true,
        isTest: true,
        currencyCode: true,
        presentmentCurrencyCode: true,
        displayFinancialStatus: true,
        displayFulfillmentStatus: true,
        currentSubtotalLineItemsQuantity: true,
        currentSubtotalAmount: true,
        currentShippingAmount: true,
        currentTotalDiscountsAmount: true,
        currentTotalTaxAmount: true,
        currentTotalAmount: true,
        discountCodes: true,
        lineItems: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            shopifyLineItemId: true,
            shopifyProductId: true,
            shopifyVariantId: true,
            sku: true,
            title: true,
            variantTitle: true,
            quantity: true,
            currentQuantity: true,
            refundableQuantity: true,
            originalUnitPrice: true,
            originalTotal: true,
            discountedTotal: true,
            discountedUnitPriceAfterAllDiscounts: true,
            totalDiscount: true,
            discountAllocations: true,
            requiresShipping: true,
            restockable: true,
            product: { select: { id: true, title: true } },
            variant: { select: { id: true, title: true, displayName: true, sku: true } },
          },
        },
        refunds: {
          orderBy: [{ shopifyCreatedAt: 'desc' }, { createdAt: 'desc' }],
          select: {
            id: true,
            shopifyRefundId: true,
            shopifyCreatedAt: true,
            processedAt: true,
            shopifyUpdatedAt: true,
            totalRefunded: true,
            currencyCode: true,
            lineItems: {
              select: {
                id: true,
                shopifyRefundLineId: true,
                quantity: true,
                restocked: true,
                restockType: true,
                price: true,
                subtotal: true,
                tax: true,
                orderLineItemId: true,
                location: { select: { id: true, name: true } },
              },
            },
          },
        },
      },
    });
    if (!order) return null;

    return {
      ...order,
      currentSubtotalAmount: decimal(order.currentSubtotalAmount),
      currentShippingAmount: decimal(order.currentShippingAmount),
      currentTotalDiscountsAmount: decimal(order.currentTotalDiscountsAmount),
      currentTotalTaxAmount: decimal(order.currentTotalTaxAmount),
      currentTotalAmount: decimal(order.currentTotalAmount),
      lineItems: order.lineItems.map((item) => ({
        ...item,
        originalUnitPrice: decimal(item.originalUnitPrice),
        originalTotal: decimal(item.originalTotal),
        discountedTotal: decimal(item.discountedTotal),
        discountedUnitPriceAfterAllDiscounts: decimal(
          item.discountedUnitPriceAfterAllDiscounts,
        ),
        totalDiscount: decimal(item.totalDiscount),
      })),
      refunds: order.refunds.map((refund) => ({
        ...refund,
        totalRefunded: decimal(refund.totalRefunded),
        lineItems: refund.lineItems.map((item) => ({
          ...item,
          price: decimal(item.price),
          subtotal: decimal(item.subtotal),
          tax: decimal(item.tax),
        })),
      })),
    };
  }
}
