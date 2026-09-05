import { createHash } from 'node:crypto';
import { AppError } from '../../../errors/app-error.js';
import { resolveAnalyticsWindows } from '../../analytics/analytics.dates.js';
import { metricChanges } from '../../analytics/analytics.metrics.js';
import type { AnalyticsListQuery, AnalyticsRangeQuery } from '../../analytics/analytics.schema.js';
import { dateWindow, storeDate } from '../../intelligence/intelligence.dates.js';
import {
  PixelBehaviorRepository,
  type BehaviorDailyInput,
} from './pixel-behavior.repository.js';

const SESSION_PAGE_SIZE = 1_000;
const DIRTY_SESSION_BATCH = 1_000;
const MAX_DIRTY_STORES = 50;

type BehaviorSession = Awaited<
  ReturnType<PixelBehaviorRepository['findSessionsForWindow']>
>[number];
type ValidOrder = Awaited<ReturnType<PixelBehaviorRepository['findValidOrders']>>[number];
type SessionProduct = BehaviorSession['products'][number];
type BehaviorDimension = 'PRODUCT' | 'COLLECTION' | 'LANDING_PAGE';
type Resolution = 'NONE' | 'EXACT' | 'PARTIAL' | 'UNRESOLVED' | 'CONFLICT';

type DailyAccumulator = BehaviorDailyInput & {
  sessionCount: number;
  pageViewCount: number;
  productViewCount: number;
  collectionViewCount: number;
  searchCount: number;
  addToCartCount: number;
  removeFromCartCount: number;
  productViewSessionCount: number;
  collectionViewSessionCount: number;
  searchSessionCount: number;
  addToCartSessionCount: number;
  checkoutStartSessionCount: number;
  checkoutCompletedSessionCount: number;
  linkedPurchaseSessionCount: number;
  conversionDelayMsTotal: bigint;
  conversionDelayCount: number;
  exactResolutionSessionCount: number;
  partialResolutionSessionCount: number;
  unresolvedResolutionSessionCount: number;
  conflictResolutionSessionCount: number;
};

interface ProductInteraction {
  dimensionKey: string;
  productId: string | null;
  variantId: string | null;
  productExternalId: string | null;
  variantExternalId: string | null;
  viewCount: number;
  addToCartCount: number;
  removeFromCartCount: number;
  resolutionStatus: Resolution;
}

const RESOLUTION_RANK: Record<Resolution, number> = {
  NONE: 0,
  EXACT: 1,
  PARTIAL: 2,
  UNRESOLVED: 3,
  CONFLICT: 4,
};

function maxResolution(left: Resolution, right: Resolution): Resolution {
  return RESOLUTION_RANK[right] > RESOLUTION_RANK[left] ? right : left;
}

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

function landingHash(url: string): string {
  return createHash('sha256').update(url).digest('hex');
}

function productKey(row: SessionProduct): string {
  if (row.productId) return `product:${row.productId}`;
  if (row.shopifyProductExternalId) return `product-external:${row.shopifyProductExternalId}`;
  if (row.variantId) return `variant:${row.variantId}`;
  if (row.shopifyVariantExternalId) return `variant-external:${row.shopifyVariantExternalId}`;
  return `unresolved:${row.identityKey}`;
}

function newAccumulator(input: {
  storeId: string;
  bucketDate: Date;
  dimension: DailyAccumulator['dimension'];
  dimensionKey: string;
  productId?: string | null;
  variantId?: string | null;
  collectionId?: string | null;
  productExternalId?: string | null;
  variantExternalId?: string | null;
  collectionExternalId?: string | null;
  landingPageHash?: string | null;
  landingPageUrl?: string | null;
}): DailyAccumulator {
  return {
    storeId: input.storeId,
    bucketDate: input.bucketDate,
    dimension: input.dimension,
    dimensionKey: input.dimensionKey,
    productId: input.productId ?? null,
    variantId: input.variantId ?? null,
    collectionId: input.collectionId ?? null,
    productExternalId: input.productExternalId ?? null,
    variantExternalId: input.variantExternalId ?? null,
    collectionExternalId: input.collectionExternalId ?? null,
    landingPageHash: input.landingPageHash ?? null,
    landingPageUrl: input.landingPageUrl ?? null,
    sessionCount: 0,
    pageViewCount: 0,
    productViewCount: 0,
    collectionViewCount: 0,
    searchCount: 0,
    addToCartCount: 0,
    removeFromCartCount: 0,
    productViewSessionCount: 0,
    collectionViewSessionCount: 0,
    searchSessionCount: 0,
    addToCartSessionCount: 0,
    checkoutStartSessionCount: 0,
    checkoutCompletedSessionCount: 0,
    linkedPurchaseSessionCount: 0,
    conversionDelayMsTotal: 0n,
    conversionDelayCount: 0,
    exactResolutionSessionCount: 0,
    partialResolutionSessionCount: 0,
    unresolvedResolutionSessionCount: 0,
    conflictResolutionSessionCount: 0,
  };
}

function conversionDelay(session: BehaviorSession, validPurchase: boolean): number | null {
  if (!validPurchase || !session.checkoutCompletedAt) return null;
  const delay = session.checkoutCompletedAt.getTime() - session.startedAt.getTime();
  return delay >= 0 ? delay : null;
}

function addCommonSession(
  row: DailyAccumulator,
  session: BehaviorSession,
  validPurchase: boolean,
  delay: number | null,
) {
  row.sessionCount += 1;
  row.pageViewCount += session.pageViewCount;
  row.productViewCount += session.productViewCount;
  row.collectionViewCount += session.collectionViewCount;
  row.searchCount += session.searchCount;
  row.addToCartCount += session.addToCartCount;
  row.removeFromCartCount += session.removeFromCartCount;
  if (session.productViewCount > 0) row.productViewSessionCount += 1;
  if (session.collectionViewCount > 0) row.collectionViewSessionCount += 1;
  if (session.searchCount > 0) row.searchSessionCount += 1;
  if (session.addToCartCount > 0) row.addToCartSessionCount += 1;
  if (session.checkoutStartedAt) row.checkoutStartSessionCount += 1;
  if (session.checkoutCompletedAt) row.checkoutCompletedSessionCount += 1;
  if (validPurchase) row.linkedPurchaseSessionCount += 1;
  if (delay !== null) {
    row.conversionDelayMsTotal += BigInt(delay);
    row.conversionDelayCount += 1;
  }
}

function addResolution(row: DailyAccumulator, resolution: Resolution) {
  if (resolution === 'EXACT') row.exactResolutionSessionCount += 1;
  if (resolution === 'PARTIAL') row.partialResolutionSessionCount += 1;
  if (resolution === 'UNRESOLVED') row.unresolvedResolutionSessionCount += 1;
  if (resolution === 'CONFLICT') row.conflictResolutionSessionCount += 1;
}

function mergeSessionProducts(products: SessionProduct[]): ProductInteraction[] {
  const merged = new Map<string, ProductInteraction>();
  for (const product of products) {
    const dimensionKey = productKey(product);
    const current = merged.get(dimensionKey) ?? {
      dimensionKey,
      productId: product.productId,
      variantId: product.variantId,
      productExternalId: product.shopifyProductExternalId,
      variantExternalId: product.shopifyVariantExternalId,
      viewCount: 0,
      addToCartCount: 0,
      removeFromCartCount: 0,
      resolutionStatus: 'NONE' as Resolution,
    };
    current.viewCount += product.viewCount;
    current.addToCartCount += product.addToCartCount;
    current.removeFromCartCount += product.removeFromCartCount;
    current.resolutionStatus = maxResolution(current.resolutionStatus, product.resolutionStatus);
    current.productId ??= product.productId;
    current.variantId ??= product.variantId;
    current.productExternalId ??= product.shopifyProductExternalId;
    current.variantExternalId ??= product.shopifyVariantExternalId;
    merged.set(dimensionKey, current);
  }
  return [...merged.values()];
}

function purchasedProduct(interaction: ProductInteraction, order: ValidOrder | null): boolean {
  if (!order) return false;
  return order.lineItems.some((line) => {
    if (interaction.productId && line.productId === interaction.productId) return true;
    if (interaction.productExternalId && line.shopifyProductId === interaction.productExternalId) return true;
    if (interaction.variantId && line.variantId === interaction.variantId) return true;
    return Boolean(
      interaction.variantExternalId && line.shopifyVariantId === interaction.variantExternalId,
    );
  });
}

function snapshot(sum: Record<string, number | bigint | null> | null | undefined) {
  const sessions = numberValue(sum?.sessionCount);
  const productViewSessions = numberValue(sum?.productViewSessionCount);
  const addToCartSessions = numberValue(sum?.addToCartSessionCount);
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
    productViewSessions,
    collectionViewSessions: numberValue(sum?.collectionViewSessionCount),
    searchSessions: numberValue(sum?.searchSessionCount),
    addToCartSessions,
    checkoutStartSessions,
    checkoutCompletedSessions: numberValue(sum?.checkoutCompletedSessionCount),
    linkedPurchaseSessions,
    productViewRate: safeRate(productViewSessions, sessions),
    addToCartRate: safeRate(addToCartSessions, sessions),
    viewToCartRate: safeRate(addToCartSessions, productViewSessions),
    checkoutStartRate: safeRate(checkoutStartSessions, sessions),
    linkedPurchaseRate: safeRate(linkedPurchaseSessions, sessions),
    cartToPurchaseRate: safeRate(linkedPurchaseSessions, addToCartSessions),
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

export class PixelBehaviorService {
  constructor(
    private readonly repository: PixelBehaviorRepository = new PixelBehaviorRepository(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  async rollupDirtyStores(storeLimit = 10) {
    const boundedStoreLimit = Math.min(Math.max(1, Math.trunc(storeLimit)), MAX_DIRTY_STORES);
    const storeIds = await this.repository.findDirtyStoreIds(boundedStoreLimit);
    let storesRolled = 0;
    let datesRebuilt = 0;
    let failed = 0;

    for (const storeId of storeIds) {
      const context = await this.repository.getStoreContext(storeId);
      if (!context) continue;
      const previousWatermark = context.storefrontBehaviorRollup?.rolledThroughMaterializedAt ?? null;
      const dirty = await this.repository.findDirtySessions(
        storeId,
        previousWatermark,
        DIRTY_SESSION_BATCH,
      );
      if (dirty.length === 0) continue;

      const dates = [...new Set(dirty.map((row) => storeDate(row.startedAt, context.ianaTimezone)))];
      try {
        for (const date of dates) {
          await this.rebuildStoreDate(storeId, context.ianaTimezone, date);
          datesRebuilt += 1;
        }
        const watermark = dirty.reduce(
          (latest, row) => (row.materializedAt > latest ? row.materializedAt : latest),
          dirty[0]!.materializedAt,
        );
        await this.repository.advanceRollupState(storeId, watermark, this.now());
        storesRolled += 1;
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message.slice(0, 1_000) : 'Behavior rollup failed';
        await this.repository.recordRollupError(storeId, message).catch(() => undefined);
      }
    }

    return { selectedStores: storeIds.length, storesRolled, datesRebuilt, failed };
  }

  async rebuildStoreDate(storeId: string, timeZone: string, date: string) {
    const window = dateWindow(date, date, timeZone);
    const day = bucketDate(date);
    const aggregates = new Map<string, DailyAccumulator>();
    let skip = 0;

    while (true) {
      const sessions = await this.repository.findSessionsForWindow(
        storeId,
        window.instantFrom,
        window.instantTo,
        skip,
        SESSION_PAGE_SIZE,
      );
      if (sessions.length === 0) break;
      const orderIds = [
        ...new Set(
          sessions
            .filter((session) => session.orderLinkStatus === 'LINKED' && session.orderId)
            .map((session) => session.orderId!),
        ),
      ];
      const validOrders = await this.repository.findValidOrders(storeId, orderIds);
      const orderMap = new Map(validOrders.map((order) => [order.id, order]));

      for (const session of sessions) {
        const order = session.orderId ? orderMap.get(session.orderId) ?? null : null;
        const validPurchase = Boolean(order);
        const delay = conversionDelay(session, validPurchase);

        const storeKey = 'STORE:store';
        const storeRow =
          aggregates.get(storeKey) ??
          newAccumulator({ storeId, bucketDate: day, dimension: 'STORE', dimensionKey: 'store' });
        addCommonSession(storeRow, session, validPurchase, delay);
        aggregates.set(storeKey, storeRow);

        if (session.landingPageUrl) {
          const hash = landingHash(session.landingPageUrl);
          const key = `LANDING_PAGE:${hash}`;
          const landingRow =
            aggregates.get(key) ??
            newAccumulator({
              storeId,
              bucketDate: day,
              dimension: 'LANDING_PAGE',
              dimensionKey: hash,
              landingPageHash: hash,
              landingPageUrl: session.landingPageUrl,
            });
          addCommonSession(landingRow, session, validPurchase, delay);
          aggregates.set(key, landingRow);
        }

        for (const product of mergeSessionProducts(session.products)) {
          const key = `PRODUCT:${product.dimensionKey}`;
          const row =
            aggregates.get(key) ??
            newAccumulator({
              storeId,
              bucketDate: day,
              dimension: 'PRODUCT',
              dimensionKey: product.dimensionKey,
              productId: product.productId,
              variantId: product.variantId,
              productExternalId: product.productExternalId,
              variantExternalId: product.variantExternalId,
            });
          row.sessionCount += 1;
          row.productViewCount += product.viewCount;
          row.addToCartCount += product.addToCartCount;
          row.removeFromCartCount += product.removeFromCartCount;
          if (product.viewCount > 0) row.productViewSessionCount += 1;
          if (product.addToCartCount > 0) row.addToCartSessionCount += 1;
          if (session.checkoutStartedAt) row.checkoutStartSessionCount += 1;
          if (session.checkoutCompletedAt) row.checkoutCompletedSessionCount += 1;
          const productPurchased = purchasedProduct(product, order);
          if (productPurchased) row.linkedPurchaseSessionCount += 1;
          if (productPurchased && delay !== null) {
            row.conversionDelayMsTotal += BigInt(delay);
            row.conversionDelayCount += 1;
          }
          addResolution(row, product.resolutionStatus);
          aggregates.set(key, row);
        }

        for (const collection of session.collections) {
          const dimensionKey = collection.collectionId
            ? `collection:${collection.collectionId}`
            : `collection-external:${collection.shopifyCollectionExternalId}`;
          const key = `COLLECTION:${dimensionKey}`;
          const row =
            aggregates.get(key) ??
            newAccumulator({
              storeId,
              bucketDate: day,
              dimension: 'COLLECTION',
              dimensionKey,
              collectionId: collection.collectionId,
              collectionExternalId: collection.shopifyCollectionExternalId,
            });
          row.sessionCount += 1;
          row.collectionViewCount += collection.viewCount;
          if (collection.viewCount > 0) row.collectionViewSessionCount += 1;
          if (session.checkoutStartedAt) row.checkoutStartSessionCount += 1;
          if (session.checkoutCompletedAt) row.checkoutCompletedSessionCount += 1;
          if (validPurchase) row.linkedPurchaseSessionCount += 1;
          if (delay !== null) {
            row.conversionDelayMsTotal += BigInt(delay);
            row.conversionDelayCount += 1;
          }
          addResolution(row, collection.resolutionStatus);
          aggregates.set(key, row);
        }
      }

      skip += sessions.length;
      if (sessions.length < SESSION_PAGE_SIZE) break;
    }

    await this.repository.replaceDailyRows(storeId, day, [...aggregates.values()]);
    return { date, rows: aggregates.size };
  }

  async overview(storeId: string, query: AnalyticsRangeQuery, now = this.now()) {
    const context = await this.repository.getStoreContext(storeId);
    if (!context) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    const windows = resolveAnalyticsWindows(query, context.ianaTimezone, now);
    const [current, comparison] = await Promise.all([
      this.repository.aggregateStore(
        storeId,
        bucketDate(windows.current.fromDate),
        bucketDate(windows.current.toDate),
      ),
      this.repository.aggregateStore(
        storeId,
        bucketDate(windows.comparison.fromDate),
        bucketDate(windows.comparison.toDate),
      ),
    ]);
    const currentMetrics = snapshot(current._sum as Record<string, number | bigint | null>);
    const comparisonMetrics = snapshot(comparison._sum as Record<string, number | bigint | null>);
    return {
      window: windows,
      current: currentMetrics,
      comparison: comparisonMetrics,
      change: metricChanges(currentMetrics, comparisonMetrics),
      dataQuality: quality(context),
      methodology: {
        source: 'STRIDE_FIRST_PARTY_BEHAVIOR_PLUS_SHOPIFY_LINKED_ORDERS',
        sessionCohort: 'Metrics are assigned to the store-local date on which the session started.',
        purchaseTruth: 'linkedPurchaseSessions counts non-test, non-cancelled Shopify orders linked by exact Shopify order identity.',
        interpretation: 'Observed first-party behavior; no causal attribution is implied.',
      },
    };
  }

  products(storeId: string, query: AnalyticsListQuery, now = this.now()) {
    return this.listDimension(storeId, 'PRODUCT', query, now);
  }

  collections(storeId: string, query: AnalyticsListQuery, now = this.now()) {
    return this.listDimension(storeId, 'COLLECTION', query, now);
  }

  landingPages(storeId: string, query: AnalyticsListQuery, now = this.now()) {
    return this.listDimension(storeId, 'LANDING_PAGE', query, now);
  }

  private async listDimension(
    storeId: string,
    dimension: BehaviorDimension,
    query: AnalyticsListQuery,
    now: Date,
  ) {
    const context = await this.repository.getStoreContext(storeId);
    if (!context) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    const windows = resolveAnalyticsWindows(query, context.ianaTimezone, now);
    const currentRows = await this.repository.groupDimension(
      storeId,
      dimension,
      bucketDate(windows.current.fromDate),
      bucketDate(windows.current.toDate),
      query.page,
      query.limit,
    );
    const keys = currentRows.map((row) => row.dimensionKey);
    const [comparisonRows, total, metadata] = await Promise.all([
      this.repository.groupDimensionKeys(
        storeId,
        dimension,
        keys,
        bucketDate(windows.comparison.fromDate),
        bucketDate(windows.comparison.toDate),
      ),
      this.repository.countDimensionKeys(
        storeId,
        dimension,
        bucketDate(windows.current.fromDate),
        bucketDate(windows.current.toDate),
      ),
      this.repository.findDimensionMetadata(storeId, dimension, keys),
    ]);
    const comparisonMap = new Map(comparisonRows.map((row) => [row.dimensionKey, row]));
    const metadataMap = new Map(metadata.map((row) => [row.dimensionKey, row]));
    const productIds = metadata.flatMap((row) => (row.productId ? [row.productId] : []));
    const collectionIds = metadata.flatMap((row) => (row.collectionId ? [row.collectionId] : []));
    const [products, collections] = await Promise.all([
      this.repository.findProductsForDisplay(storeId, [...new Set(productIds)]),
      this.repository.findCollectionsForDisplay(storeId, [...new Set(collectionIds)]),
    ]);
    const productMap = new Map(products.map((row) => [row.id, row]));
    const collectionMap = new Map(collections.map((row) => [row.id, row]));

    const items = currentRows.map((row) => {
      const meta = metadataMap.get(row.dimensionKey) ?? null;
      const current = snapshot(row._sum as Record<string, number | bigint | null>);
      const comparisonRow = comparisonMap.get(row.dimensionKey);
      const comparison = snapshot(
        comparisonRow?._sum as Record<string, number | bigint | null> | undefined,
      );
      return {
        dimensionKey: row.dimensionKey,
        product: meta?.productId ? productMap.get(meta.productId) ?? null : null,
        collection: meta?.collectionId ? collectionMap.get(meta.collectionId) ?? null : null,
        productExternalId: meta?.productExternalId ?? null,
        variantExternalId: meta?.variantExternalId ?? null,
        collectionExternalId: meta?.collectionExternalId ?? null,
        landingPageUrl: meta?.landingPageUrl ?? null,
        current,
        comparison,
        change: metricChanges(current, comparison),
      };
    });

    return {
      window: windows,
      dimension,
      items,
      pagination: { page: query.page, limit: query.limit, total },
      dataQuality: quality(context),
      methodology: {
        source: 'STRIDE_FIRST_PARTY_BEHAVIOR_PLUS_SHOPIFY_LINKED_ORDERS',
        sessionCohort: 'Metrics are assigned to the store-local date on which the session started.',
        purchaseTruth: 'Purchase metrics require an exact link to a non-test, non-cancelled Shopify order.',
        collectionInterpretation:
          dimension === 'COLLECTION'
            ? 'A collection purchase is downstream same-session purchase evidence, not causal collection attribution.'
            : null,
        interpretation: 'Observed first-party behavior; no causal attribution is implied.',
      },
    };
  }
}

export const pixelBehaviorService = new PixelBehaviorService();
