import { createHash } from 'node:crypto';
import { AppError } from '../../../errors/app-error.js';
import { resolveAnalyticsWindows } from '../../analytics/analytics.dates.js';
import { metricChanges } from '../../analytics/analytics.metrics.js';
import type { AnalyticsListQuery } from '../../analytics/analytics.schema.js';
import { addDateDays, dateWindow, storeDate } from '../../intelligence/intelligence.dates.js';
import {
  PixelAttributionRepository,
  type AttributionDailyInput,
  type AttributionPathDailyInput,
  type MetaTargetEvidenceDailyInput,
} from './pixel-attribution.repository.js';

const LOOKBACK_DAYS = 30;
const SESSION_PAGE_SIZE = 1_000;
const DIRTY_SESSION_BATCH = 1_000;
const MAX_DIRTY_STORES = 50;
const MAPPING_SUGGESTION_MIN_SESSIONS = 5;
const MAPPING_SUGGESTION_MIN_VIEW_RATE = 0.6;
const MAX_PIXEL_ONLY_MAPPING_CONFIDENCE = 0.69;

type AttributionSession = Awaited<
  ReturnType<PixelAttributionRepository['findSessionsForWindow']>
>[number];
type AttributionTouch = AttributionSession['touches'][number];
type ValidOrder = Awaited<ReturnType<PixelAttributionRepository['findValidOrders']>>[number];
type JourneySession = Awaited<
  ReturnType<PixelAttributionRepository['findVisitorJourneySessions']>
>[number];
type JourneyTouch = JourneySession['touches'][number];
type TargetType = 'PRODUCT' | 'COLLECTION';

type AttributionAccumulator = AttributionDailyInput & {
  touchedSessionCount: number;
  linkedPurchaseSessionCount: number;
  firstTouchPurchaseSessionCount: number;
  lastTouchPurchaseSessionCount: number;
  assistedPurchaseSessionCount: number;
  singleTouchPurchaseSessionCount: number;
  crossSessionPurchaseCount: number;
  conversionDelayMsTotal: bigint;
  conversionDelayCount: number;
  exactMetaResolutionSessionCount: number;
};

type PathAccumulator = AttributionPathDailyInput & {
  sessionCount: number;
  linkedPurchaseSessionCount: number;
  crossSessionPurchaseCount: number;
  conversionDelayMsTotal: bigint;
  conversionDelayCount: number;
};

type TargetAccumulator = MetaTargetEvidenceDailyInput & {
  interactedSessionCount: number;
  viewedSessionCount: number;
  addToCartSessionCount: number;
  linkedPurchaseSessionCount: number;
  firstTouchPurchaseSessionCount: number;
  lastTouchPurchaseSessionCount: number;
  assistedPurchaseSessionCount: number;
};

interface FlattenedTouch extends JourneyTouch {
  journeySessionId: string;
  journeySessionStartedAt: Date;
}

interface TouchIdentity {
  key: string;
  source: AttributionTouch['source'];
  metaCampaignId: string | null;
  metaAdSetId: string | null;
  metaAdId: string | null;
  metaCampaignExternalId: string | null;
  metaAdSetExternalId: string | null;
  metaAdExternalId: string | null;
  exactMeta: boolean;
}

function bucketDate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

function safeRate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function numberValue(value: number | bigint | null | undefined): number {
  if (typeof value === 'bigint') return Number(value);
  return value ?? 0;
}

function sourceKey(source: AttributionTouch['source']): string {
  return `source:${source}`;
}

function exactMetaIdentity(touch: AttributionTouch | JourneyTouch): TouchIdentity | null {
  if (touch.source !== 'META' || !touch.metaAdId || touch.metaResolutionStatus !== 'EXACT') return null;
  return {
    key: `meta-ad:${touch.metaAdId}`,
    source: 'META',
    metaCampaignId: touch.metaCampaignId,
    metaAdSetId: touch.metaAdSetId,
    metaAdId: touch.metaAdId,
    metaCampaignExternalId: touch.metaCampaignExternalId,
    metaAdSetExternalId: touch.metaAdSetExternalId,
    metaAdExternalId: touch.metaAdExternalId,
    exactMeta: true,
  };
}

function sourceIdentity(touch: AttributionTouch | JourneyTouch): TouchIdentity {
  return {
    key: sourceKey(touch.source),
    source: touch.source,
    metaCampaignId: null,
    metaAdSetId: null,
    metaAdId: null,
    metaCampaignExternalId: null,
    metaAdSetExternalId: null,
    metaAdExternalId: null,
    exactMeta: false,
  };
}

function newAttributionRow(
  storeId: string,
  day: Date,
  identity: TouchIdentity,
  dimension: 'SOURCE' | 'META_AD',
): AttributionAccumulator {
  return {
    storeId,
    bucketDate: day,
    dimension,
    dimensionKey: identity.key,
    source: identity.source,
    metaCampaignId: identity.metaCampaignId,
    metaAdSetId: identity.metaAdSetId,
    metaAdId: identity.metaAdId,
    metaCampaignExternalId: identity.metaCampaignExternalId,
    metaAdSetExternalId: identity.metaAdSetExternalId,
    metaAdExternalId: identity.metaAdExternalId,
    touchedSessionCount: 0,
    linkedPurchaseSessionCount: 0,
    firstTouchPurchaseSessionCount: 0,
    lastTouchPurchaseSessionCount: 0,
    assistedPurchaseSessionCount: 0,
    singleTouchPurchaseSessionCount: 0,
    crossSessionPurchaseCount: 0,
    conversionDelayMsTotal: 0n,
    conversionDelayCount: 0,
    exactMetaResolutionSessionCount: 0,
  };
}

function newPathRow(storeId: string, day: Date, path: string): PathAccumulator {
  return {
    storeId,
    bucketDate: day,
    pathHash: hash(path),
    path,
    sessionCount: 0,
    linkedPurchaseSessionCount: 0,
    crossSessionPurchaseCount: 0,
    conversionDelayMsTotal: 0n,
    conversionDelayCount: 0,
  };
}

function newTargetRow(input: {
  storeId: string;
  day: Date;
  ad: TouchIdentity;
  targetType: TargetType;
  targetKey: string;
  productId?: string | null;
  collectionId?: string | null;
  productExternalId?: string | null;
  variantExternalId?: string | null;
  collectionExternalId?: string | null;
}): TargetAccumulator {
  return {
    storeId: input.storeId,
    bucketDate: input.day,
    metaAdId: input.ad.metaAdId!,
    metaAdExternalId: input.ad.metaAdExternalId!,
    targetType: input.targetType,
    targetKey: input.targetKey,
    productId: input.productId ?? null,
    collectionId: input.collectionId ?? null,
    productExternalId: input.productExternalId ?? null,
    variantExternalId: input.variantExternalId ?? null,
    collectionExternalId: input.collectionExternalId ?? null,
    interactedSessionCount: 0,
    viewedSessionCount: 0,
    addToCartSessionCount: 0,
    linkedPurchaseSessionCount: 0,
    firstTouchPurchaseSessionCount: 0,
    lastTouchPurchaseSessionCount: 0,
    assistedPurchaseSessionCount: 0,
  };
}

function sourcePath(touches: Array<AttributionTouch | JourneyTouch>): string {
  const sources: string[] = [];
  for (const touch of touches) {
    if (sources.at(-1) !== touch.source) sources.push(touch.source);
  }
  return sources.length > 0 ? sources.join('>') : 'UNKNOWN';
}

function uniqueIdentities(touches: Array<AttributionTouch | JourneyTouch>): TouchIdentity[] {
  const identities = new Map<string, TouchIdentity>();
  for (const touch of touches) {
    const source = sourceIdentity(touch);
    identities.set(source.key, source);
    const meta = exactMetaIdentity(touch);
    if (meta) identities.set(meta.key, meta);
  }
  return [...identities.values()];
}

function flattenJourney(sessions: JourneySession[]): FlattenedTouch[] {
  return sessions
    .flatMap((session) =>
      session.touches.map((touch) => ({
        ...touch,
        journeySessionId: session.id,
        journeySessionStartedAt: session.startedAt,
      })),
    )
    .sort((left, right) => {
      const time = left.eventAt.getTime() - right.eventAt.getTime();
      if (time !== 0) return time;
      return left.ordinal - right.ordinal;
    });
}

function validPurchaseDelay(current: AttributionSession, journeySessions: JourneySession[]): number | null {
  if (!current.checkoutCompletedAt) return null;
  const firstStart = journeySessions.reduce(
    (earliest, session) => (session.startedAt < earliest ? session.startedAt : earliest),
    current.startedAt,
  );
  const delay = current.checkoutCompletedAt.getTime() - firstStart.getTime();
  return delay >= 0 ? delay : null;
}

function productTargetKey(product: AttributionSession['products'][number]): string {
  if (product.productId) return `product:${product.productId}`;
  if (product.shopifyProductExternalId) return `product-external:${product.shopifyProductExternalId}`;
  if (product.variantId) return `variant:${product.variantId}`;
  return `variant-external:${product.shopifyVariantExternalId ?? product.identityKey}`;
}

function collectionTargetKey(collection: AttributionSession['collections'][number]): string {
  return collection.collectionId
    ? `collection:${collection.collectionId}`
    : `collection-external:${collection.shopifyCollectionExternalId}`;
}

function productPurchased(product: AttributionSession['products'][number], order: ValidOrder | null): boolean {
  if (!order) return false;
  return order.lineItems.some((line) => {
    if (product.productId && line.productId === product.productId) return true;
    if (product.shopifyProductExternalId && line.shopifyProductId === product.shopifyProductExternalId) return true;
    if (product.variantId && line.variantId === product.variantId) return true;
    return Boolean(
      product.shopifyVariantExternalId && line.shopifyVariantId === product.shopifyVariantExternalId,
    );
  });
}

function attributionSnapshot(sum: Record<string, number | bigint | null> | undefined) {
  const touchedSessions = numberValue(sum?.touchedSessionCount);
  const purchases = numberValue(sum?.linkedPurchaseSessionCount);
  const delayCount = numberValue(sum?.conversionDelayCount);
  return {
    touchedSessions,
    linkedPurchaseSessions: purchases,
    firstTouchPurchaseSessions: numberValue(sum?.firstTouchPurchaseSessionCount),
    lastTouchPurchaseSessions: numberValue(sum?.lastTouchPurchaseSessionCount),
    assistedPurchaseSessions: numberValue(sum?.assistedPurchaseSessionCount),
    singleTouchPurchaseSessions: numberValue(sum?.singleTouchPurchaseSessionCount),
    crossSessionPurchaseSessions: numberValue(sum?.crossSessionPurchaseCount),
    touchToPurchaseRate: safeRate(purchases, touchedSessions),
    averageJourneyToPurchaseMs:
      delayCount > 0 ? numberValue(sum?.conversionDelayMsTotal) / delayCount : null,
    exactMetaResolutionSessions: numberValue(sum?.exactMetaResolutionSessionCount),
  };
}

function pathSnapshot(path: string, sum: Record<string, number | bigint | null> | undefined) {
  const sessions = numberValue(sum?.sessionCount);
  const purchases = numberValue(sum?.linkedPurchaseSessionCount);
  const delayCount = numberValue(sum?.conversionDelayCount);
  const kind = path.startsWith('JOURNEY:') ? 'PURCHASE_JOURNEY' : 'SESSION';
  return {
    kind,
    sessions,
    linkedPurchaseSessions: purchases,
    crossSessionPurchaseSessions: numberValue(sum?.crossSessionPurchaseCount),
    purchaseRate: kind === 'SESSION' ? safeRate(purchases, sessions) : null,
    averageJourneyToPurchaseMs:
      delayCount > 0 ? numberValue(sum?.conversionDelayMsTotal) / delayCount : null,
  };
}

function pathMetricValues(snapshot: ReturnType<typeof pathSnapshot>) {
  return {
    sessions: snapshot.sessions,
    linkedPurchaseSessions: snapshot.linkedPurchaseSessions,
    crossSessionPurchaseSessions: snapshot.crossSessionPurchaseSessions,
    purchaseRate: snapshot.purchaseRate,
    averageJourneyToPurchaseMs: snapshot.averageJourneyToPurchaseMs,
  };
}

function quality(context: Awaited<ReturnType<PixelAttributionRepository['getStoreContext']>>) {
  if (!context) return { state: 'NOT_READY' as const, limitations: ['PIXEL_STORE_NOT_FOUND'] };
  const rollup = context.storefrontAttributionRollup;
  if (!rollup?.lastRolledUpAt) {
    return {
      state: 'NOT_READY' as const,
      limitations: ['PIXEL_ATTRIBUTION_NOT_ROLLED_UP'],
      latestPixelEventAt: context.pixelInstallation?.lastEventAt ?? null,
      lastRolledUpAt: null,
    };
  }
  return {
    state: rollup.lastError ? ('DEGRADED' as const) : ('READY' as const),
    limitations: rollup.lastError ? ['PIXEL_ATTRIBUTION_ROLLUP_ERROR'] : [],
    latestPixelEventAt: context.pixelInstallation?.lastEventAt ?? null,
    rolledThroughSessionUpdatedAt: rollup.rolledThroughSessionUpdatedAt,
    lastRolledUpAt: rollup.lastRolledUpAt,
  };
}

export class PixelAttributionService {
  constructor(
    private readonly repository: PixelAttributionRepository = new PixelAttributionRepository(),
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
      const dirty = await this.repository.findDirtySessions(storeId, DIRTY_SESSION_BATCH);
      if (dirty.length === 0) continue;
      const acknowledgedAt = this.now();

      const dirtyDates = new Set<string>();
      for (const row of dirty) {
        dirtyDates.add(storeDate(row.startedAt, context.ianaTimezone));
        if (row.previousStartedAt) dirtyDates.add(storeDate(row.previousStartedAt, context.ianaTimezone));
      }
      const visitors = [
        ...new Set(dirty.flatMap((row) => (row.anonymousVisitorId ? [row.anonymousVisitorId] : []))),
      ];
      if (visitors.length > 0) {
        const earliest = dirty.reduce(
          (value, row) => (row.startedAt < value ? row.startedAt : value),
          dirty[0]!.startedAt,
        );
        const latest = dirty.reduce(
          (value, row) => (row.startedAt > value ? row.startedAt : value),
          dirty[0]!.startedAt,
        );
        const through = new Date(latest.getTime() + LOOKBACK_DAYS * 86_400_000);
        const laterPurchases = await this.repository.findLaterPurchaseSessions(
          storeId,
          visitors,
          earliest,
          through,
        );
        for (const purchase of laterPurchases) {
          dirtyDates.add(storeDate(purchase.startedAt, context.ianaTimezone));
        }
      }

      try {
        for (const date of [...dirtyDates].sort()) {
          await this.rebuildStoreDate(storeId, context.ianaTimezone, date);
          datesRebuilt += 1;
        }
        await this.repository.acknowledgeSessions(storeId, dirty, acknowledgedAt);
        const watermark = dirty.reduce(
          (latest, row) => (row.dirtyAt > latest ? row.dirtyAt : latest),
          dirty[0]!.dirtyAt,
        );
        await this.repository.advanceRollupState(storeId, watermark, this.now());
        storesRolled += 1;
      } catch (error) {
        failed += 1;
        const message = error instanceof Error ? error.message.slice(0, 1_000) : 'Attribution rollup failed';
        await this.repository.recordRollupError(storeId, message).catch(() => undefined);
      }
    }

    return { selectedStores: storeIds.length, storesRolled, datesRebuilt, failed };
  }

  async rebuildStoreDate(storeId: string, timeZone: string, date: string) {
    const window = dateWindow(date, date, timeZone);
    const day = bucketDate(date);
    const attribution = new Map<string, AttributionAccumulator>();
    const paths = new Map<string, PathAccumulator>();
    const targets = new Map<string, TargetAccumulator>();
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
        const sessionIdentities = uniqueIdentities(session.touches);

        for (const identity of sessionIdentities) {
          const dimension = identity.exactMeta ? 'META_AD' : 'SOURCE';
          const mapKey = `${dimension}:${identity.key}`;
          const row = attribution.get(mapKey) ?? newAttributionRow(storeId, day, identity, dimension);
          row.touchedSessionCount += 1;
          if (identity.exactMeta) row.exactMetaResolutionSessionCount += 1;
          attribution.set(mapKey, row);
        }

        const purchaseCutoff =
          validPurchase && session.checkoutCompletedAt ? session.checkoutCompletedAt : session.endedAt;
        const sessionPathTouches = session.touches.filter((touch) => touch.eventAt <= purchaseCutoff);
        const sessionPath = `SESSION:${sourcePath(sessionPathTouches)}`;
        const sessionPathKey = hash(sessionPath);
        const sessionPathRow = paths.get(sessionPathKey) ?? newPathRow(storeId, day, sessionPath);
        sessionPathRow.sessionCount += 1;
        if (validPurchase) sessionPathRow.linkedPurchaseSessionCount += 1;
        paths.set(sessionPathKey, sessionPathRow);

        let purchaseJourney: JourneySession[] = [];
        let flattened: FlattenedTouch[] = [];
        let journeyIdentities: TouchIdentity[] = [];
        const firstIdentityKeys = new Set<string>();
        const lastIdentityKeys = new Set<string>();
        const assistedIdentityKeys = new Set<string>();
        let delay: number | null = null;
        let crossSession = false;

        if (validPurchase) {
          if (session.anonymousVisitorId) {
            const fromDate = storeDate(session.startedAt, timeZone);
            const lookbackDate = addDateDays(fromDate, -LOOKBACK_DAYS);
            purchaseJourney = await this.repository.findVisitorJourneySessions(
              storeId,
              session.anonymousVisitorId,
              dateWindow(lookbackDate, lookbackDate, timeZone).instantFrom,
              purchaseCutoff,
            );
          }
          if (purchaseJourney.length === 0) {
            purchaseJourney = [
              {
                id: session.id,
                startedAt: session.startedAt,
                touches: session.touches.filter((touch) => touch.eventAt <= purchaseCutoff),
              },
            ];
          }
          flattened = flattenJourney(purchaseJourney).filter((touch) => touch.eventAt <= purchaseCutoff);
          journeyIdentities = uniqueIdentities(flattened);
          crossSession = new Set(flattened.map((touch) => touch.journeySessionId)).size > 1;
          delay = validPurchaseDelay(session, purchaseJourney);

          const firstTouch = flattened[0];
          const lastTouch = flattened.at(-1);
          if (firstTouch) {
            firstIdentityKeys.add(sourceKey(firstTouch.source));
            const firstMeta = exactMetaIdentity(firstTouch);
            if (firstMeta) firstIdentityKeys.add(firstMeta.key);
          }
          if (lastTouch) {
            lastIdentityKeys.add(sourceKey(lastTouch.source));
            const lastMeta = exactMetaIdentity(lastTouch);
            if (lastMeta) lastIdentityKeys.add(lastMeta.key);
          }
          for (const touch of flattened.slice(0, -1)) {
            assistedIdentityKeys.add(sourceKey(touch.source));
            const meta = exactMetaIdentity(touch);
            if (meta) assistedIdentityKeys.add(meta.key);
          }

          for (const identity of journeyIdentities) {
            const dimension = identity.exactMeta ? 'META_AD' : 'SOURCE';
            const mapKey = `${dimension}:${identity.key}`;
            const row = attribution.get(mapKey) ?? newAttributionRow(storeId, day, identity, dimension);
            row.linkedPurchaseSessionCount += 1;
            if (firstIdentityKeys.has(identity.key)) row.firstTouchPurchaseSessionCount += 1;
            if (lastIdentityKeys.has(identity.key)) row.lastTouchPurchaseSessionCount += 1;
            if (assistedIdentityKeys.has(identity.key)) row.assistedPurchaseSessionCount += 1;
            if (flattened.length === 1) row.singleTouchPurchaseSessionCount += 1;
            if (crossSession) row.crossSessionPurchaseCount += 1;
            if (delay !== null) {
              row.conversionDelayMsTotal += BigInt(delay);
              row.conversionDelayCount += 1;
            }
            attribution.set(mapKey, row);
          }

          const journeyPath = `JOURNEY:${sourcePath(flattened)}`;
          const journeyPathKey = hash(journeyPath);
          const journeyPathRow = paths.get(journeyPathKey) ?? newPathRow(storeId, day, journeyPath);
          journeyPathRow.linkedPurchaseSessionCount += 1;
          if (crossSession) journeyPathRow.crossSessionPurchaseCount += 1;
          if (delay !== null) {
            journeyPathRow.conversionDelayMsTotal += BigInt(delay);
            journeyPathRow.conversionDelayCount += 1;
          }
          paths.set(journeyPathKey, journeyPathRow);
        }

        const journeyIdentityKeys = new Set(journeyIdentities.map((identity) => identity.key));
        const exactAds = new Map<string, TouchIdentity>();
        for (const touch of session.touches) {
          const ad = exactMetaIdentity(touch);
          if (ad) exactAds.set(ad.key, ad);
        }

        for (const ad of exactAds.values()) {
          for (const product of session.products.filter((row) => row.resolutionStatus === 'EXACT')) {
            const targetKey = productTargetKey(product);
            const key = `${ad.metaAdId}:PRODUCT:${targetKey}`;
            const row =
              targets.get(key) ??
              newTargetRow({
                storeId,
                day,
                ad,
                targetType: 'PRODUCT',
                targetKey,
                productId: product.productId,
                productExternalId: product.shopifyProductExternalId,
                variantExternalId: product.shopifyVariantExternalId,
              });
            row.interactedSessionCount += 1;
            if (product.viewCount > 0) row.viewedSessionCount += 1;
            if (product.addToCartCount > 0) row.addToCartSessionCount += 1;
            const purchased = productPurchased(product, order) && journeyIdentityKeys.has(ad.key);
            if (purchased) {
              row.linkedPurchaseSessionCount += 1;
              if (firstIdentityKeys.has(ad.key)) row.firstTouchPurchaseSessionCount += 1;
              if (lastIdentityKeys.has(ad.key)) row.lastTouchPurchaseSessionCount += 1;
              if (assistedIdentityKeys.has(ad.key)) row.assistedPurchaseSessionCount += 1;
            }
            targets.set(key, row);
          }

          for (const collection of session.collections.filter((row) => row.resolutionStatus === 'EXACT')) {
            const targetKey = collectionTargetKey(collection);
            const key = `${ad.metaAdId}:COLLECTION:${targetKey}`;
            const row =
              targets.get(key) ??
              newTargetRow({
                storeId,
                day,
                ad,
                targetType: 'COLLECTION',
                targetKey,
                collectionId: collection.collectionId,
                collectionExternalId: collection.shopifyCollectionExternalId,
              });
            row.interactedSessionCount += 1;
            if (collection.viewCount > 0) row.viewedSessionCount += 1;
            if (validPurchase && journeyIdentityKeys.has(ad.key)) {
              row.linkedPurchaseSessionCount += 1;
              if (firstIdentityKeys.has(ad.key)) row.firstTouchPurchaseSessionCount += 1;
              if (lastIdentityKeys.has(ad.key)) row.lastTouchPurchaseSessionCount += 1;
              if (assistedIdentityKeys.has(ad.key)) row.assistedPurchaseSessionCount += 1;
            }
            targets.set(key, row);
          }
        }
      }

      skip += sessions.length;
      if (sessions.length < SESSION_PAGE_SIZE) break;
    }

    return this.repository.replaceDailyRows(
      storeId,
      day,
      [...attribution.values()],
      [...paths.values()],
      [...targets.values()],
    );
  }

  sources(storeId: string, query: AnalyticsListQuery, now = this.now()) {
    return this.listAttribution(storeId, 'SOURCE', query, now);
  }

  metaAds(storeId: string, query: AnalyticsListQuery, now = this.now()) {
    return this.listAttribution(storeId, 'META_AD', query, now);
  }

  async paths(storeId: string, query: AnalyticsListQuery, now = this.now()) {
    const context = await this.repository.getStoreContext(storeId);
    if (!context) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    const windows = resolveAnalyticsWindows(query, context.ianaTimezone, now);
    const currentRows = await this.repository.groupPaths(
      storeId,
      bucketDate(windows.current.fromDate),
      bucketDate(windows.current.toDate),
      query.page,
      query.limit,
    );
    const hashes = currentRows.map((row) => row.pathHash);
    const [comparisonRows, total] = await Promise.all([
      this.repository.groupPathHashes(
        storeId,
        hashes,
        bucketDate(windows.comparison.fromDate),
        bucketDate(windows.comparison.toDate),
      ),
      this.repository.countPaths(
        storeId,
        bucketDate(windows.current.fromDate),
        bucketDate(windows.current.toDate),
      ),
    ]);
    const comparisonMap = new Map(comparisonRows.map((row) => [row.pathHash, row]));
    return {
      window: windows,
      items: currentRows.map((row) => {
        const current = pathSnapshot(row.path, row._sum as Record<string, number | bigint | null>);
        const comparison = pathSnapshot(
          row.path,
          comparisonMap.get(row.pathHash)?._sum as Record<string, number | bigint | null> | undefined,
        );
        return {
          path: row.path,
          current,
          comparison,
          change: metricChanges(pathMetricValues(current), pathMetricValues(comparison)),
        };
      }),
      pagination: { page: query.page, limit: query.limit, total },
      dataQuality: quality(context),
      methodology: this.methodology(),
    };
  }

  async mappingEvidence(
    storeId: string,
    targetType: TargetType,
    query: AnalyticsListQuery,
    now = this.now(),
  ) {
    const context = await this.repository.getStoreContext(storeId);
    if (!context) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    const windows = resolveAnalyticsWindows(query, context.ianaTimezone, now);
    const currentFrom = bucketDate(windows.current.fromDate);
    const currentTo = bucketDate(windows.current.toDate);
    const rows = await this.repository.groupTargetEvidence(
      storeId,
      targetType,
      currentFrom,
      currentTo,
      query.page,
      query.limit,
    );
    const adIds = [...new Set(rows.map((row) => row.metaAdId))];
    const targetKeys = [...new Set(rows.map((row) => row.targetKey))];
    const [total, metadata, ads, activeMappings, allRowsForAds] = await Promise.all([
      this.repository.countTargetEvidence(storeId, targetType, currentFrom, currentTo),
      this.repository.findTargetMetadata(storeId, adIds, targetKeys),
      this.repository.findMetaAdsForDisplay(storeId, adIds),
      this.repository.findActiveMappings(storeId, adIds),
      this.repository.groupTargetEvidenceForAds(storeId, targetType, adIds, currentFrom, currentTo),
    ]);
    const metaMap = new Map(metadata.map((row) => [`${row.metaAdId}:${row.targetKey}`, row]));
    const adMap = new Map(ads.map((row) => [row.id, row]));
    const productIds = metadata.flatMap((row) => (row.productId ? [row.productId] : []));
    const collectionIds = metadata.flatMap((row) => (row.collectionId ? [row.collectionId] : []));
    const [products, collections] = await Promise.all([
      this.repository.findProductsForDisplay(storeId, [...new Set(productIds)]),
      this.repository.findCollectionsForDisplay(storeId, [...new Set(collectionIds)]),
    ]);
    const productMap = new Map(products.map((row) => [row.id, row]));
    const collectionMap = new Map(collections.map((row) => [row.id, row]));

    const prelim = rows.map((row) => {
      const meta = metaMap.get(`${row.metaAdId}:${row.targetKey}`) ?? null;
      const interacted = numberValue(row._sum.interactedSessionCount);
      const viewed = numberValue(row._sum.viewedSessionCount);
      const purchased = numberValue(row._sum.linkedPurchaseSessionCount);
      const viewRate = safeRate(viewed, interacted) ?? 0;
      const purchaseRate = safeRate(purchased, interacted) ?? 0;
      const eligible =
        interacted >= MAPPING_SUGGESTION_MIN_SESSIONS && viewRate >= MAPPING_SUGGESTION_MIN_VIEW_RATE;
      const support = Math.min(interacted / 20, 1);
      const suggestedConfidence = eligible
        ? Math.min(
            MAX_PIXEL_ONLY_MAPPING_CONFIDENCE,
            0.45 + support * 0.12 + viewRate * 0.08 + Math.min(purchaseRate * 2, 1) * 0.04,
          )
        : null;
      return {
        metaAdId: row.metaAdId,
        targetKey: row.targetKey,
        meta,
        ad: adMap.get(row.metaAdId) ?? null,
        product: meta?.productId ? productMap.get(meta.productId) ?? null : null,
        collection: meta?.collectionId ? collectionMap.get(meta.collectionId) ?? null : null,
        evidence: {
          interactedSessions: interacted,
          viewedSessions: viewed,
          addToCartSessions: numberValue(row._sum.addToCartSessionCount),
          linkedPurchaseSessions: purchased,
          firstTouchPurchaseSessions: numberValue(row._sum.firstTouchPurchaseSessionCount),
          lastTouchPurchaseSessions: numberValue(row._sum.lastTouchPurchaseSessionCount),
          assistedPurchaseSessions: numberValue(row._sum.assistedPurchaseSessionCount),
          viewRate,
          linkedPurchaseRate: purchaseRate,
        },
        eligible,
        suggestedConfidence,
      };
    });

    const eligibleCountByAd = new Map<string, number>();
    for (const row of allRowsForAds) {
      const interacted = numberValue(row._sum.interactedSessionCount);
      const viewed = numberValue(row._sum.viewedSessionCount);
      const viewRate = safeRate(viewed, interacted) ?? 0;
      const eligible =
        interacted >= MAPPING_SUGGESTION_MIN_SESSIONS && viewRate >= MAPPING_SUGGESTION_MIN_VIEW_RATE;
      if (eligible) eligibleCountByAd.set(row.metaAdId, (eligibleCountByAd.get(row.metaAdId) ?? 0) + 1);
    }

    const items = prelim.map((row) => {
      const existingProducts = activeMappings.products.filter((mapping) => mapping.metaAdId === row.metaAdId);
      const existingCollections = activeMappings.collections.filter((mapping) => mapping.metaAdId === row.metaAdId);
      const sameExisting =
        targetType === 'PRODUCT'
          ? existingProducts.find((mapping) => mapping.productId === row.meta?.productId)
          : existingCollections.find((mapping) => mapping.collectionId === row.meta?.collectionId);
      const merchantConflict =
        targetType === 'PRODUCT'
          ? existingProducts.some(
              (mapping) => mapping.isMerchantConfirmed && mapping.productId !== row.meta?.productId,
            )
          : existingCollections.some(
              (mapping) => mapping.isMerchantConfirmed && mapping.collectionId !== row.meta?.collectionId,
            );
      const shared = row.eligible && (eligibleCountByAd.get(row.metaAdId) ?? 0) > 1;
      let status = 'INSUFFICIENT_EVIDENCE';
      if (sameExisting) status = 'SUPPORTS_EXISTING';
      else if (merchantConflict) status = 'CONFLICTS_WITH_MERCHANT_MAPPING';
      else if (shared) status = 'POSSIBLE_SHARED_SCOPE';
      else if (row.eligible) status = 'REVIEW_SUGGESTION';

      return {
        ad: row.ad,
        targetType,
        product: row.product,
        collection: row.collection,
        productExternalId: row.meta?.productExternalId ?? null,
        variantExternalId: row.meta?.variantExternalId ?? null,
        collectionExternalId: row.meta?.collectionExternalId ?? null,
        evidence: row.evidence,
        suggestion: {
          status,
          suggestedConfidence: row.suggestedConfidence,
          suggestedScope: shared
            ? targetType === 'PRODUCT'
              ? 'MULTI_PRODUCT'
              : 'UNKNOWN'
            : targetType,
          automaticallyActivatesMapping: false,
          exactMappingThreshold: 0.7,
          limitation:
            'First-party behavioral association is mapping evidence, not proof that the ad exclusively targets this Shopify entity.',
        },
        existingMapping: sameExisting ?? null,
      };
    });

    return {
      window: windows.current,
      targetType,
      items,
      pagination: { page: query.page, limit: query.limit, total },
      thresholds: {
        minimumInteractedSessions: MAPPING_SUGGESTION_MIN_SESSIONS,
        minimumViewRate: MAPPING_SUGGESTION_MIN_VIEW_RATE,
        maximumPixelOnlySuggestedConfidence: MAX_PIXEL_ONLY_MAPPING_CONFIDENCE,
      },
      dataQuality: quality(context),
      methodology: this.methodology(),
    };
  }

  private async listAttribution(
    storeId: string,
    dimension: 'SOURCE' | 'META_AD',
    query: AnalyticsListQuery,
    now: Date,
  ) {
    const context = await this.repository.getStoreContext(storeId);
    if (!context) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    const windows = resolveAnalyticsWindows(query, context.ianaTimezone, now);
    const currentRows = await this.repository.groupAttribution(
      storeId,
      dimension,
      bucketDate(windows.current.fromDate),
      bucketDate(windows.current.toDate),
      query.page,
      query.limit,
    );
    const keys = currentRows.map((row) => row.dimensionKey);
    const [comparisonRows, total, metadata] = await Promise.all([
      this.repository.groupAttributionKeys(
        storeId,
        dimension,
        keys,
        bucketDate(windows.comparison.fromDate),
        bucketDate(windows.comparison.toDate),
      ),
      this.repository.countAttributionKeys(
        storeId,
        dimension,
        bucketDate(windows.current.fromDate),
        bucketDate(windows.current.toDate),
      ),
      this.repository.findAttributionMetadata(storeId, keys),
    ]);
    const comparisonMap = new Map(comparisonRows.map((row) => [row.dimensionKey, row]));
    const metadataMap = new Map(metadata.map((row) => [row.dimensionKey, row]));
    const adIds = metadata.flatMap((row) => (row.metaAdId ? [row.metaAdId] : []));
    const ads = await this.repository.findMetaAdsForDisplay(storeId, [...new Set(adIds)]);
    const adMap = new Map(ads.map((row) => [row.id, row]));

    return {
      window: windows,
      dimension,
      items: currentRows.map((row) => {
        const current = attributionSnapshot(row._sum as Record<string, number | bigint | null>);
        const comparison = attributionSnapshot(
          comparisonMap.get(row.dimensionKey)?._sum as
            | Record<string, number | bigint | null>
            | undefined,
        );
        const meta = metadataMap.get(row.dimensionKey) ?? null;
        return {
          dimensionKey: row.dimensionKey,
          source: meta?.source ?? null,
          ad: meta?.metaAdId ? adMap.get(meta.metaAdId) ?? null : null,
          metaCampaignExternalId: meta?.metaCampaignExternalId ?? null,
          metaAdSetExternalId: meta?.metaAdSetExternalId ?? null,
          metaAdExternalId: meta?.metaAdExternalId ?? null,
          current,
          comparison,
          change: metricChanges(current, comparison),
        };
      }),
      pagination: { page: query.page, limit: query.limit, total },
      dataQuality: quality(context),
      methodology: this.methodology(),
    };
  }

  private methodology() {
    return {
      source: 'STRIDE_FIRST_PARTY_JOURNEY_PLUS_SHOPIFY_ORDER_TRUTH',
      lookbackDays: LOOKBACK_DAYS,
      firstTouch: 'First observed touch inside the retained 30-day first-party journey window.',
      lastTouch:
        'Last observed touch at or before checkout completion inside the retained 30-day journey window.',
      assistedTouch:
        'An observed touch before the final pre-purchase touch in a Shopify-linked purchase journey.',
      purchaseTruth: 'Only exact non-test, non-cancelled Shopify order links count as purchases.',
      pathSemantics:
        'SESSION paths expose a conversion denominator; JOURNEY paths are purchase-only descriptive paths and intentionally return a null purchase rate.',
      interpretation:
        'Descriptive first-party attribution evidence only; no causal or incrementality claim is implied.',
    };
  }
}

export const pixelAttributionService = new PixelAttributionService();
