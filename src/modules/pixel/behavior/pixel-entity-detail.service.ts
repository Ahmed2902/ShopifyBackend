import { AppError } from '../../../errors/app-error.js';
import { prisma } from '../../../lib/prisma.js';
import { resolveAnalyticsWindows } from '../../analytics/analytics.dates.js';
import { metricChanges } from '../../analytics/analytics.metrics.js';
import type { AnalyticsRangeQuery } from '../../analytics/analytics.schema.js';
import { PixelBehaviorRepository } from './pixel-behavior.repository.js';

type Dimension = 'PRODUCT' | 'COLLECTION';

function bucketDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function safeRate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function numberValue(value: number | bigint | null | undefined): number {
  if (typeof value === 'bigint') return Number(value);
  return value ?? 0;
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

type Metrics = ReturnType<typeof snapshot>;
type Accumulator = Record<string, number | bigint | null>;

function addRow(target: Accumulator, row: Record<string, unknown>) {
  const fields = [
    'sessionCount',
    'pageViewCount',
    'productViewCount',
    'collectionViewCount',
    'searchCount',
    'addToCartCount',
    'removeFromCartCount',
    'cartViewCount',
    'productViewSessionCount',
    'collectionViewSessionCount',
    'searchSessionCount',
    'addToCartSessionCount',
    'cartViewSessionCount',
    'cartViewCheckoutSessionCount',
    'cartViewPurchaseSessionCount',
    'checkoutStartSessionCount',
    'checkoutCompletedSessionCount',
    'linkedPurchaseSessionCount',
    'conversionDelayMsTotal',
    'conversionDelayCount',
    'exactResolutionSessionCount',
    'partialResolutionSessionCount',
    'unresolvedResolutionSessionCount',
    'conflictResolutionSessionCount',
  ] as const;

  for (const field of fields) {
    const value = row[field];
    if (typeof value === 'bigint') target[field] = BigInt(target[field] ?? 0) + value;
    else target[field] = Number(target[field] ?? 0) + Number(value ?? 0);
  }
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

function methodology(dimension: Dimension) {
  return {
    source: 'STRIDE_FIRST_PARTY_BEHAVIOR_PLUS_SHOPIFY_LINKED_ORDERS',
    sessionCohort: 'Metrics are assigned to the store-local date on which the session started.',
    purchaseTruth: 'Purchase metrics require an exact link to a non-test, non-cancelled Shopify order.',
    collectionInterpretation:
      dimension === 'COLLECTION'
        ? 'A collection purchase is downstream same-session purchase evidence, not causal collection attribution.'
        : null,
    interpretation: 'Observed first-party behavior; no causal attribution is implied.',
  };
}

export class PixelEntityDetailService {
  constructor(private readonly repository = new PixelBehaviorRepository()) {}

  async detail(storeId: string, dimension: Dimension, entityId: string, query: AnalyticsRangeQuery, now = new Date()) {
    const result = await this.batch(storeId, dimension, [entityId], query, now);
    const item = result.items[0]!;
    return {
      window: result.window,
      dimension,
      entityId,
      current: item.current,
      comparison: item.comparison,
      change: item.change,
      dataQuality: result.dataQuality,
      methodology: methodology(dimension),
    };
  }

  async batch(storeId: string, dimension: Dimension, entityIds: string[], query: AnalyticsRangeQuery, now = new Date()) {
    const context = await this.repository.getStoreContext(storeId);
    if (!context) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    const windows = resolveAnalyticsWindows(query, context.ianaTimezone, now);
    const uniqueIds = [...new Set(entityIds)];
    const rows = await prisma.storefrontBehaviorDaily.findMany({
      where: {
        storeId,
        dimension,
        bucketDate: {
          gte: bucketDate(windows.comparison.fromDate),
          lte: bucketDate(windows.current.toDate),
        },
        ...(dimension === 'PRODUCT'
          ? { productId: { in: uniqueIds } }
          : { collectionId: { in: uniqueIds } }),
      },
    });
    const currentFrom = bucketDate(windows.current.fromDate).getTime();
    const maps = new Map<string, { current: Accumulator; comparison: Accumulator }>();

    for (const row of rows) {
      const id = dimension === 'PRODUCT' ? row.productId : row.collectionId;
      if (!id) continue;
      const item = maps.get(id) ?? { current: {}, comparison: {} };
      addRow(row.bucketDate.getTime() >= currentFrom ? item.current : item.comparison, row as unknown as Record<string, unknown>);
      maps.set(id, item);
    }

    return {
      window: windows,
      dimension,
      items: uniqueIds.map((entityId) => {
        const values = maps.get(entityId);
        const current: Metrics = snapshot(values?.current);
        const comparison: Metrics = snapshot(values?.comparison);
        return { entityId, current, comparison, change: metricChanges(current, comparison) };
      }),
      dataQuality: quality(context),
    };
  }

  async sources(storeId: string, dimension: Dimension, entityId: string, query: AnalyticsRangeQuery, now = new Date()) {
    const context = await this.repository.getStoreContext(storeId);
    if (!context) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    const windows = resolveAnalyticsWindows(query, context.ianaTimezone, now);
    const sessionWhere = {
      storeId,
      startedAt: { gte: windows.current.instantFrom, lte: windows.current.instantTo },
    };

    const rows = dimension === 'PRODUCT'
      ? await prisma.storefrontSessionProduct.findMany({
          where: { productId: entityId, session: sessionWhere },
          select: {
            session: {
              select: {
                id: true,
                touches: { orderBy: { ordinal: 'asc' as const }, take: 1, select: { source: true } },
              },
            },
          },
        })
      : await prisma.storefrontSessionCollection.findMany({
          where: { collectionId: entityId, session: sessionWhere },
          select: {
            session: {
              select: {
                id: true,
                touches: { orderBy: { ordinal: 'asc' as const }, take: 1, select: { source: true } },
              },
            },
          },
        });

    const bySession = new Map<string, string>();
    for (const row of rows) bySession.set(row.session.id, row.session.touches[0]?.source ?? 'UNKNOWN');
    const counts = new Map<string, number>();
    for (const source of bySession.values()) counts.set(source, (counts.get(source) ?? 0) + 1);

    return {
      window: { current: { from: windows.current.fromDate, to: windows.current.toDate } },
      dimension,
      entityId,
      methodology: 'FIRST_TOUCH_SOURCE_AMONG_SESSIONS_WITH_ENTITY_INTERACTION' as const,
      items: [...counts.entries()]
        .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
        .map(([source, sessions]) => ({ source, sessions })),
    };
  }
}

export const pixelEntityDetailService = new PixelEntityDetailService();
