import { AppError } from '../../../errors/app-error.js';
import { resolveAnalyticsWindows } from '../../analytics/analytics.dates.js';
import { metricChanges } from '../../analytics/analytics.metrics.js';
import type { AnalyticsRangeQuery } from '../../analytics/analytics.schema.js';
import { PixelBehaviorRepository } from './pixel-behavior.repository.js';

function bucketDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function numberValue(value: number | bigint | null | undefined): number {
  if (typeof value === 'bigint') return Number(value);
  return value ?? 0;
}

function safeRate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function snapshot(sum: Record<string, number | bigint | null> | null | undefined) {
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
    productViewRate: safeRate(productViewSessions, sessions),
    addToCartRate: safeRate(addToCartSessions, sessions),
    cartViewRate: safeRate(cartViewSessions, sessions),
    viewToCartRate: safeRate(addToCartSessions, productViewSessions),
    cartViewToCheckoutRate: safeRate(cartViewCheckoutSessions, cartViewSessions),
    checkoutStartRate: safeRate(checkoutStartSessions, sessions),
    linkedPurchaseRate: safeRate(linkedPurchaseSessions, sessions),
    cartToPurchaseRate: safeRate(linkedPurchaseSessions, addToCartSessions),
    cartViewToPurchaseRate: safeRate(cartViewPurchaseSessions, cartViewSessions),
    checkoutToPurchaseRate: safeRate(linkedPurchaseSessions, checkoutStartSessions),
    averageSessionToPurchaseMs: delayCount > 0 ? delayTotal / delayCount : null,
    exactResolutionSessions: numberValue(sum?.exactResolutionSessionCount),
    partialResolutionSessions: numberValue(sum?.partialResolutionSessionCount),
    unresolvedResolutionSessions: numberValue(sum?.unresolvedResolutionSessionCount),
    conflictResolutionSessions: numberValue(sum?.conflictResolutionSessionCount),
  };
}

function quality(context: Awaited<ReturnType<PixelBehaviorRepository['getStoreContext']>>) {
  if (!context) return { state: 'NOT_READY' as const, limitations: ['PIXEL_STORE_NOT_FOUND'] };
  const rollup = context.storefrontBehaviorRollup;
  if (!rollup?.lastRolledUpAt) {
    return {
      state: 'NOT_READY' as const,
      limitations: ['PIXEL_ANALYTICS_NOT_ROLLED_UP'],
      latestPixelEventAt: context.pixelInstallation?.lastEventAt ?? null,
      lastRolledUpAt: null,
    };
  }
  return {
    state: rollup.lastError ? ('DEGRADED' as const) : ('READY' as const),
    limitations: rollup.lastError ? ['PIXEL_ANALYTICS_ROLLUP_ERROR'] : [],
    latestPixelEventAt: context.pixelInstallation?.lastEventAt ?? null,
    rolledThroughMaterializedAt: rollup.rolledThroughMaterializedAt,
    lastRolledUpAt: rollup.lastRolledUpAt,
  };
}

export class PixelBehaviorDetailService {
  constructor(
    private readonly repository: PixelBehaviorRepository = new PixelBehaviorRepository(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  product(storeId: string, productId: string, query: AnalyticsRangeQuery, now = this.now()) {
    return this.detail(storeId, 'PRODUCT', productId, query, now);
  }

  collection(storeId: string, collectionId: string, query: AnalyticsRangeQuery, now = this.now()) {
    return this.detail(storeId, 'COLLECTION', collectionId, query, now);
  }

  private async detail(
    storeId: string,
    dimension: 'PRODUCT' | 'COLLECTION',
    entityId: string,
    query: AnalyticsRangeQuery,
    now: Date,
  ) {
    const context = await this.repository.getStoreContext(storeId);
    if (!context) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    const windows = resolveAnalyticsWindows(query, context.ianaTimezone, now);
    const aggregate = dimension === 'PRODUCT'
      ? this.repository.aggregateProduct.bind(this.repository)
      : this.repository.aggregateCollection.bind(this.repository);
    const [currentRow, comparisonRow] = await Promise.all([
      aggregate(storeId, entityId, bucketDate(windows.current.fromDate), bucketDate(windows.current.toDate)),
      aggregate(storeId, entityId, bucketDate(windows.comparison.fromDate), bucketDate(windows.comparison.toDate)),
    ]);
    const current = snapshot(currentRow._sum as Record<string, number | bigint | null>);
    const comparison = snapshot(comparisonRow._sum as Record<string, number | bigint | null>);

    return {
      window: windows,
      dimension,
      entityId,
      current,
      comparison,
      change: metricChanges(current, comparison),
      dataQuality: quality(context),
      methodology: {
        source: 'STRIDE_FIRST_PARTY_BEHAVIOR_PLUS_SHOPIFY_LINKED_ORDERS',
        sessionCohort: 'Metrics are assigned to the store-local date on which the session started.',
        purchaseTruth: dimension === 'PRODUCT'
          ? 'Product purchases require an exact linked Shopify order containing this product or its resolved variant.'
          : 'Collection purchases are downstream same-session purchase evidence for sessions that viewed this collection; no causal attribution is implied.',
        interpretation: 'Observed first-party behavior; no causal attribution is implied.',
      },
    };
  }
}

export const pixelBehaviorDetailService = new PixelBehaviorDetailService();
