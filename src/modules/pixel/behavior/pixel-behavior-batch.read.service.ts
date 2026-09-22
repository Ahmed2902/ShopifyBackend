import { prisma } from '../../../lib/prisma.js';
import { AppError } from '../../../errors/app-error.js';
import { resolveAnalyticsWindows } from '../../analytics/analytics.dates.js';
import { metricChanges } from '../../analytics/analytics.metrics.js';
import type { AnalyticsRangeQuery } from '../../analytics/analytics.schema.js';
import { PixelBehaviorRepository } from './pixel-behavior.repository.js';

const SUM_FIELDS = {
  sessionCount: true,
  pageViewCount: true,
  productViewCount: true,
  collectionViewCount: true,
  searchCount: true,
  addToCartCount: true,
  removeFromCartCount: true,
  cartViewCount: true,
  productViewSessionCount: true,
  collectionViewSessionCount: true,
  searchSessionCount: true,
  addToCartSessionCount: true,
  cartViewSessionCount: true,
  cartViewCheckoutSessionCount: true,
  cartViewPurchaseSessionCount: true,
  checkoutStartSessionCount: true,
  checkoutCompletedSessionCount: true,
  linkedPurchaseSessionCount: true,
  conversionDelayMsTotal: true,
  conversionDelayCount: true,
  exactResolutionSessionCount: true,
  partialResolutionSessionCount: true,
  unresolvedResolutionSessionCount: true,
  conflictResolutionSessionCount: true,
} as const;

function bucketDate(value: string) {
  return new Date(`${value}T00:00:00.000Z`);
}

function numberValue(value: number | bigint | null | undefined) {
  return typeof value === 'bigint' ? Number(value) : value ?? 0;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function metrics(sum: Record<string, number | bigint | null> | undefined) {
  const sessions = numberValue(sum?.sessionCount);
  const productViewSessions = numberValue(sum?.productViewSessionCount);
  const addToCartSessions = numberValue(sum?.addToCartSessionCount);
  const cartViewSessions = numberValue(sum?.cartViewSessionCount);
  const cartViewCheckoutSessions = numberValue(sum?.cartViewCheckoutSessionCount);
  const cartViewPurchaseSessions = numberValue(sum?.cartViewPurchaseSessionCount);
  const checkoutStartSessions = numberValue(sum?.checkoutStartSessionCount);
  const linkedPurchaseSessions = numberValue(sum?.linkedPurchaseSessionCount);
  const delayCount = numberValue(sum?.conversionDelayCount);
  const delayTotal = numberValue(sum?.conversionDelayMsTotal);
  return {
    sessions,
    pageViews: numberValue(sum?.pageViewCount),
    productViews: numberValue(sum?.productViewCount),
    collectionViews: numberValue(sum?.collectionViewCount),
    searches: numberValue(sum?.searchCount),
    addToCartEvents: numberValue(sum?.addToCartCount),
    removeFromCartEvents: numberValue(sum?.removeFromCartCount),
    cartViews: numberValue(sum?.cartViewCount),
    productViewSessions,
    collectionViewSessions: numberValue(sum?.collectionViewSessionCount),
    searchSessions: numberValue(sum?.searchSessionCount),
    addToCartSessions,
    cartViewSessions,
    cartViewCheckoutSessions,
    cartViewPurchaseSessions,
    checkoutStartSessions,
    checkoutCompletedSessions: numberValue(sum?.checkoutCompletedSessionCount),
    linkedPurchaseSessions,
    productViewRate: rate(productViewSessions, sessions),
    addToCartRate: rate(addToCartSessions, sessions),
    cartViewRate: rate(cartViewSessions, sessions),
    viewToCartRate: rate(addToCartSessions, productViewSessions),
    cartViewToCheckoutRate: rate(cartViewCheckoutSessions, cartViewSessions),
    checkoutStartRate: rate(checkoutStartSessions, sessions),
    linkedPurchaseRate: rate(linkedPurchaseSessions, sessions),
    cartToPurchaseRate: rate(linkedPurchaseSessions, addToCartSessions),
    cartViewToPurchaseRate: rate(cartViewPurchaseSessions, cartViewSessions),
    checkoutToPurchaseRate: rate(linkedPurchaseSessions, checkoutStartSessions),
    averageSessionToPurchaseMs: delayCount > 0 ? delayTotal / delayCount : null,
    exactResolutionSessions: numberValue(sum?.exactResolutionSessionCount),
    partialResolutionSessions: numberValue(sum?.partialResolutionSessionCount),
    unresolvedResolutionSessions: numberValue(sum?.unresolvedResolutionSessionCount),
    conflictResolutionSessions: numberValue(sum?.conflictResolutionSessionCount),
  };
}

export class PixelBehaviorBatchReadService {
  constructor(private readonly repository = new PixelBehaviorRepository()) {}

  products(storeId: string, ids: string[], query: AnalyticsRangeQuery, now = new Date()) {
    return this.read(storeId, 'PRODUCT', ids, query, now);
  }

  collections(storeId: string, ids: string[], query: AnalyticsRangeQuery, now = new Date()) {
    return this.read(storeId, 'COLLECTION', ids, query, now);
  }

  private async read(
    storeId: string,
    dimension: 'PRODUCT' | 'COLLECTION',
    ids: string[],
    query: AnalyticsRangeQuery,
    now: Date,
  ) {
    const context = await this.repository.getStoreContext(storeId);
    if (!context) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    const windows = resolveAnalyticsWindows(query, context.ianaTimezone, now);
    if (ids.length === 0) return { window: windows, dimension, items: [] };

    const relationField = dimension === 'PRODUCT' ? 'productId' : 'collectionId';
    const currentWhere = {
      storeId,
      dimension,
      [relationField]: { in: ids },
      bucketDate: { gte: bucketDate(windows.current.fromDate), lte: bucketDate(windows.current.toDate) },
    };
    const comparisonWhere = {
      storeId,
      dimension,
      [relationField]: { in: ids },
      bucketDate: { gte: bucketDate(windows.comparison.fromDate), lte: bucketDate(windows.comparison.toDate) },
    };

    const [currentRows, comparisonRows] = dimension === 'PRODUCT'
      ? await Promise.all([
          prisma.storefrontBehaviorDaily.groupBy({ by: ['productId'], where: currentWhere, _sum: SUM_FIELDS }),
          prisma.storefrontBehaviorDaily.groupBy({ by: ['productId'], where: comparisonWhere, _sum: SUM_FIELDS }),
        ])
      : await Promise.all([
          prisma.storefrontBehaviorDaily.groupBy({ by: ['collectionId'], where: currentWhere, _sum: SUM_FIELDS }),
          prisma.storefrontBehaviorDaily.groupBy({ by: ['collectionId'], where: comparisonWhere, _sum: SUM_FIELDS }),
        ]);

    const currentMap = new Map(currentRows.map((row) => [dimension === 'PRODUCT' ? row.productId : row.collectionId, row]));
    const comparisonMap = new Map(comparisonRows.map((row) => [dimension === 'PRODUCT' ? row.productId : row.collectionId, row]));

    return {
      window: windows,
      dimension,
      items: ids.map((entityId) => {
        const current = metrics(currentMap.get(entityId)?._sum as Record<string, number | bigint | null> | undefined);
        const comparison = metrics(comparisonMap.get(entityId)?._sum as Record<string, number | bigint | null> | undefined);
        return { entityId, current, comparison, change: metricChanges(current, comparison) };
      }),
    };
  }
}

export const pixelBehaviorBatchReadService = new PixelBehaviorBatchReadService();
