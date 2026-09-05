import {
  Prisma,
  type StorefrontAttributionDimension,
  type StorefrontAttributionTargetType,
} from '../../../generated/prisma/client.js';
import { withPostgresAdvisoryLock } from '../../../lib/postgres-advisory-lock.js';
import { prisma } from '../../../lib/prisma.js';

const ATTRIBUTION_SUM_FIELDS = {
  touchedSessionCount: true,
  linkedPurchaseSessionCount: true,
  firstTouchPurchaseSessionCount: true,
  lastTouchPurchaseSessionCount: true,
  assistedPurchaseSessionCount: true,
  singleTouchPurchaseSessionCount: true,
  crossSessionPurchaseCount: true,
  conversionDelayMsTotal: true,
  conversionDelayCount: true,
  exactMetaResolutionSessionCount: true,
} as const;

const TARGET_SUM_FIELDS = {
  interactedSessionCount: true,
  viewedSessionCount: true,
  addToCartSessionCount: true,
  linkedPurchaseSessionCount: true,
  firstTouchPurchaseSessionCount: true,
  lastTouchPurchaseSessionCount: true,
  assistedPurchaseSessionCount: true,
} as const;

const PATH_SUM_FIELDS = {
  sessionCount: true,
  linkedPurchaseSessionCount: true,
  crossSessionPurchaseCount: true,
  conversionDelayMsTotal: true,
  conversionDelayCount: true,
} as const;

export type AttributionDailyInput = Omit<
  Prisma.StorefrontAttributionDailyCreateManyInput,
  'id' | 'createdAt' | 'updatedAt'
>;
export type AttributionPathDailyInput = Omit<
  Prisma.StorefrontAttributionPathDailyCreateManyInput,
  'id' | 'createdAt' | 'updatedAt'
>;
export type MetaTargetEvidenceDailyInput = Omit<
  Prisma.StorefrontMetaTargetEvidenceDailyCreateManyInput,
  'id' | 'createdAt' | 'updatedAt'
>;

export interface AttributionDirtySession {
  id: string;
  startedAt: Date;
  previousStartedAt: Date | null;
  rollupDirtyAt: Date;
  orderUpdatedAt: Date | null;
  dirtyAt: Date;
  anonymousVisitorId: string | null;
  visitorIds: string[];
}

export class PixelAttributionRepository {
  getStoreContext(storeId: string) {
    return prisma.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        ianaTimezone: true,
        pixelInstallation: { select: { status: true, lastEventAt: true } },
        storefrontAttributionRollup: {
          select: {
            rolledThroughSessionUpdatedAt: true,
            lastRolledUpAt: true,
            lastError: true,
          },
        },
      },
    });
  }

  async findDirtyStoreIds(limit: number) {
    const rows = await prisma.$queryRaw<Array<{ storeId: string }>>`
      SELECT
        s."storeId" AS "storeId",
        GREATEST(
          COALESCE(r."lastRolledUpAt", TIMESTAMP 'epoch'),
          COALESCE(r."updatedAt", TIMESTAMP 'epoch')
        ) AS "lastAttemptAt"
      FROM "StorefrontSession" s
      LEFT JOIN "Order" o ON o."id" = s."orderId"
      LEFT JOIN "StorefrontAttributionRollupState" r ON r."storeId" = s."storeId"
      WHERE s."attributionRolledUpAt" IS NULL
         OR s."attributionRolledUpAt" < s."rollupDirtyAt"
         OR s."attributionRolledStartedAt" IS DISTINCT FROM s."startedAt"
         OR (o."id" IS NOT NULL AND o."updatedAt" > s."attributionRolledUpAt")
      GROUP BY s."storeId", r."lastRolledUpAt", r."updatedAt"
      ORDER BY "lastAttemptAt" ASC, s."storeId" ASC
      LIMIT ${limit}
    `;
    return rows.map((row) => row.storeId);
  }

  withStoreRollupLock<T>(storeId: string, work: () => Promise<T>): Promise<T> {
    return withPostgresAdvisoryLock(`stride:pixel:attribution:${storeId}`, work);
  }

  findDirtySessions(storeId: string, limit: number) {
    return prisma.$queryRaw<AttributionDirtySession[]>`
      SELECT
        s."id",
        s."startedAt",
        s."attributionRolledStartedAt" AS "previousStartedAt",
        s."rollupDirtyAt" AS "rollupDirtyAt",
        o."updatedAt" AS "orderUpdatedAt",
        GREATEST(s."rollupDirtyAt", COALESCE(o."updatedAt", s."rollupDirtyAt")) AS "dirtyAt",
        s."anonymousVisitorId",
        ARRAY(
          SELECT DISTINCT e."anonymousVisitorId"
          FROM "StorefrontEvent" e
          WHERE e."storeId" = s."storeId"
            AND e."sessionId" = s."browserSessionId"
            AND e."anonymousVisitorId" IS NOT NULL
          ORDER BY e."anonymousVisitorId"
        ) AS "visitorIds"
      FROM "StorefrontSession" s
      LEFT JOIN "Order" o ON o."id" = s."orderId"
      WHERE s."storeId" = ${storeId}::uuid
        AND (
          s."attributionRolledUpAt" IS NULL
          OR s."attributionRolledUpAt" < s."rollupDirtyAt"
          OR s."attributionRolledStartedAt" IS DISTINCT FROM s."startedAt"
          OR (o."id" IS NOT NULL AND o."updatedAt" > s."attributionRolledUpAt")
        )
      ORDER BY "dirtyAt" ASC, s."id" ASC
      LIMIT ${limit}
    `;
  }

  findLaterPurchaseSessions(
    storeId: string,
    anonymousVisitorIds: string[],
    from: Date,
    to: Date,
  ) {
    if (anonymousVisitorIds.length === 0) return Promise.resolve([]);
    // The attribution journey uses store-local calendar dates, so an exact 30*24h upper bound can
    // end before the last instant of the 30th local boundary date (and DST can widen the gap).
    // Conservatively pad two UTC days here. This can rebuild a small amount of extra data but
    // guarantees every purchase that could be inside the 30-calendar-day journey window is dirtied.
    const conservativeTo = new Date(to.getTime() + 2 * 86_400_000);
    return prisma.storefrontSession.findMany({
      where: {
        storeId,
        anonymousVisitorId: { in: anonymousVisitorIds },
        startedAt: { gte: from, lte: conservativeTo },
        orderLinkStatus: 'LINKED',
        orderId: { not: null },
      },
      select: { startedAt: true },
    });
  }

  findSessionsForWindow(storeId: string, from: Date, to: Date, skip: number, take: number) {
    return prisma.storefrontSession.findMany({
      where: { storeId, eventCount: { gt: 0 }, startedAt: { gte: from, lte: to } },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      skip,
      take,
      select: {
        id: true,
        anonymousVisitorId: true,
        startedAt: true,
        endedAt: true,
        checkoutCompletedAt: true,
        orderId: true,
        orderLinkStatus: true,
        touches: {
          orderBy: { ordinal: 'asc' },
          select: {
            ordinal: true,
            eventAt: true,
            source: true,
            metaCampaignId: true,
            metaAdSetId: true,
            metaAdId: true,
            metaCampaignExternalId: true,
            metaAdSetExternalId: true,
            metaAdExternalId: true,
            metaResolutionStatus: true,
          },
        },
        products: {
          select: {
            identityKey: true,
            productId: true,
            variantId: true,
            shopifyProductExternalId: true,
            shopifyVariantExternalId: true,
            resolutionStatus: true,
            viewCount: true,
            addToCartCount: true,
          },
        },
        collections: {
          select: {
            collectionId: true,
            shopifyCollectionExternalId: true,
            resolutionStatus: true,
            viewCount: true,
          },
        },
      },
    });
  }

  findVisitorJourneySessions(storeId: string, anonymousVisitorId: string, from: Date, to: Date) {
    return prisma.storefrontSession.findMany({
      where: {
        storeId,
        anonymousVisitorId,
        eventCount: { gt: 0 },
        startedAt: { gte: from, lte: to },
      },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        startedAt: true,
        touches: {
          where: { eventAt: { lte: to } },
          orderBy: { ordinal: 'asc' },
          select: {
            ordinal: true,
            eventAt: true,
            source: true,
            metaCampaignId: true,
            metaAdSetId: true,
            metaAdId: true,
            metaCampaignExternalId: true,
            metaAdSetExternalId: true,
            metaAdExternalId: true,
            metaResolutionStatus: true,
          },
        },
      },
    });
  }

  findValidOrders(storeId: string, orderIds: string[]) {
    if (orderIds.length === 0) return Promise.resolve([]);
    return prisma.order.findMany({
      where: { id: { in: orderIds }, storeId, isTest: false, cancelledAt: null },
      select: {
        id: true,
        lineItems: {
          where: { currentQuantity: { gt: 0 } },
          select: {
            productId: true,
            variantId: true,
            shopifyProductId: true,
            shopifyVariantId: true,
          },
        },
      },
    });
  }

  async replaceDailyRows(
    storeId: string,
    bucketDate: Date,
    attribution: AttributionDailyInput[],
    paths: AttributionPathDailyInput[],
    targets: MetaTargetEvidenceDailyInput[],
  ) {
    // Daily purchase credit is bucketed by the purchase session's store-local date. A credited
    // identity can originate in an earlier retained session, so the purchase-date row may not have
    // received the current-session touch increment. Persist a cohort-aligned denominator rather
    // than allowing durable facts such as 1 purchase / 0 touched sessions. JOURNEY paths are
    // purchase-only descriptive cohorts, so their sessionCount is the number of represented
    // purchase journeys (their API purchase rate remains intentionally null).
    const normalizedAttribution = attribution.map((row) => ({
      ...row,
      touchedSessionCount: Math.max(row.touchedSessionCount ?? 0, row.linkedPurchaseSessionCount ?? 0),
    }));
    const normalizedPaths = paths.map((row) => ({
      ...row,
      sessionCount: row.path.startsWith('JOURNEY:')
        ? Math.max(row.sessionCount ?? 0, row.linkedPurchaseSessionCount ?? 0)
        : row.sessionCount,
    }));

    return prisma.$transaction(async (tx) => {
      await tx.storefrontAttributionDaily.deleteMany({ where: { storeId, bucketDate } });
      await tx.storefrontAttributionPathDaily.deleteMany({ where: { storeId, bucketDate } });
      await tx.storefrontMetaTargetEvidenceDaily.deleteMany({ where: { storeId, bucketDate } });
      if (normalizedAttribution.length > 0) {
        await tx.storefrontAttributionDaily.createMany({ data: normalizedAttribution });
      }
      if (normalizedPaths.length > 0) {
        await tx.storefrontAttributionPathDaily.createMany({ data: normalizedPaths });
      }
      if (targets.length > 0) await tx.storefrontMetaTargetEvidenceDaily.createMany({ data: targets });
      return {
        attribution: normalizedAttribution.length,
        paths: normalizedPaths.length,
        targets: targets.length,
      };
    });
  }

  async acknowledgeSessions(storeId: string, sessions: AttributionDirtySession[], acknowledgedAt: Date) {
    if (sessions.length === 0) return 0;
    const versions = Prisma.join(
      sessions.map(
        (row) => Prisma.sql`(
          ${row.id}::uuid,
          ${row.startedAt}::timestamp(3),
          ${row.rollupDirtyAt}::timestamp(3),
          ${row.orderUpdatedAt}::timestamp(3)
        )`,
      ),
    );
    return prisma.$executeRaw`
      UPDATE "StorefrontSession" s
      SET
        "attributionRolledUpAt" = ${acknowledgedAt},
        "attributionRolledStartedAt" = s."startedAt",
        "updatedAt" = CURRENT_TIMESTAMP
      FROM (VALUES ${versions}) AS v("id", "startedAt", "rollupDirtyAt", "orderUpdatedAt")
      WHERE s."storeId" = ${storeId}::uuid
        AND s."id" = v."id"
        AND s."startedAt" = v."startedAt"
        AND s."rollupDirtyAt" = v."rollupDirtyAt"
        AND (
          SELECT o."updatedAt"
          FROM "Order" o
          WHERE o."id" = s."orderId"
        ) IS NOT DISTINCT FROM v."orderUpdatedAt"
    `;
  }

  advanceRollupState(storeId: string, watermark: Date, rolledUpAt: Date) {
    return prisma.storefrontAttributionRollupState.upsert({
      where: { storeId },
      create: {
        storeId,
        rolledThroughSessionUpdatedAt: watermark,
        lastRolledUpAt: rolledUpAt,
        lastError: null,
      },
      update: {
        rolledThroughSessionUpdatedAt: watermark,
        lastRolledUpAt: rolledUpAt,
        lastError: null,
      },
      select: { storeId: true },
    });
  }

  recordRollupError(storeId: string, message: string) {
    return prisma.storefrontAttributionRollupState.upsert({
      where: { storeId },
      create: { storeId, lastError: message },
      update: { lastError: message },
      select: { storeId: true },
    });
  }

  groupAttribution(
    storeId: string,
    dimension: StorefrontAttributionDimension,
    fromDate: Date,
    toDate: Date,
    page: number,
    limit: number,
  ) {
    return prisma.storefrontAttributionDaily.groupBy({
      by: ['dimensionKey'],
      where: { storeId, dimension, bucketDate: { gte: fromDate, lte: toDate } },
      _sum: ATTRIBUTION_SUM_FIELDS,
      orderBy: [{ _sum: { linkedPurchaseSessionCount: 'desc' } }, { dimensionKey: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  groupAttributionKeys(
    storeId: string,
    dimension: StorefrontAttributionDimension,
    keys: string[],
    fromDate: Date,
    toDate: Date,
  ) {
    if (keys.length === 0) return Promise.resolve([]);
    return prisma.storefrontAttributionDaily.groupBy({
      by: ['dimensionKey'],
      where: { storeId, dimension, dimensionKey: { in: keys }, bucketDate: { gte: fromDate, lte: toDate } },
      _sum: ATTRIBUTION_SUM_FIELDS,
    });
  }

  async countAttributionKeys(
    storeId: string,
    dimension: StorefrontAttributionDimension,
    fromDate: Date,
    toDate: Date,
  ) {
    const rows = await prisma.storefrontAttributionDaily.findMany({
      where: { storeId, dimension, bucketDate: { gte: fromDate, lte: toDate } },
      distinct: ['dimensionKey'],
      select: { dimensionKey: true },
    });
    return rows.length;
  }

  async findAttributionMetadata(storeId: string, keys: string[]) {
    if (keys.length === 0) return [];
    const rows = await prisma.storefrontAttributionDaily.findMany({
      where: { storeId, dimensionKey: { in: keys } },
      orderBy: [{ bucketDate: 'desc' }, { updatedAt: 'desc' }],
      select: {
        dimensionKey: true,
        source: true,
        metaCampaignId: true,
        metaAdSetId: true,
        metaAdId: true,
        metaCampaignExternalId: true,
        metaAdSetExternalId: true,
        metaAdExternalId: true,
      },
    });
    const seen = new Set<string>();
    return rows.filter((row) => {
      if (seen.has(row.dimensionKey)) return false;
      seen.add(row.dimensionKey);
      return true;
    });
  }

  groupPaths(storeId: string, fromDate: Date, toDate: Date, page: number, limit: number) {
    return prisma.storefrontAttributionPathDaily.groupBy({
      by: ['pathHash', 'path'],
      where: { storeId, bucketDate: { gte: fromDate, lte: toDate } },
      _sum: PATH_SUM_FIELDS,
      orderBy: [{ _sum: { linkedPurchaseSessionCount: 'desc' } }, { pathHash: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  groupPathHashes(storeId: string, hashes: string[], fromDate: Date, toDate: Date) {
    if (hashes.length === 0) return Promise.resolve([]);
    return prisma.storefrontAttributionPathDaily.groupBy({
      by: ['pathHash', 'path'],
      where: { storeId, pathHash: { in: hashes }, bucketDate: { gte: fromDate, lte: toDate } },
      _sum: PATH_SUM_FIELDS,
    });
  }

  async countPaths(storeId: string, fromDate: Date, toDate: Date) {
    const rows = await prisma.storefrontAttributionPathDaily.findMany({
      where: { storeId, bucketDate: { gte: fromDate, lte: toDate } },
      distinct: ['pathHash'],
      select: { pathHash: true },
    });
    return rows.length;
  }

  groupTargetEvidence(
    storeId: string,
    targetType: StorefrontAttributionTargetType,
    fromDate: Date,
    toDate: Date,
    page: number,
    limit: number,
  ) {
    return prisma.storefrontMetaTargetEvidenceDaily.groupBy({
      by: ['metaAdId', 'targetKey'],
      where: { storeId, targetType, bucketDate: { gte: fromDate, lte: toDate } },
      _sum: TARGET_SUM_FIELDS,
      orderBy: [{ _sum: { interactedSessionCount: 'desc' } }, { targetKey: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  groupTargetEvidenceForAds(
    storeId: string,
    targetType: StorefrontAttributionTargetType,
    metaAdIds: string[],
    fromDate: Date,
    toDate: Date,
  ) {
    if (metaAdIds.length === 0) return Promise.resolve([]);
    return prisma.storefrontMetaTargetEvidenceDaily.groupBy({
      by: ['metaAdId', 'targetKey'],
      where: {
        storeId,
        targetType,
        metaAdId: { in: metaAdIds },
        bucketDate: { gte: fromDate, lte: toDate },
      },
      _sum: TARGET_SUM_FIELDS,
    });
  }

  async countTargetEvidence(
    storeId: string,
    targetType: StorefrontAttributionTargetType,
    fromDate: Date,
    toDate: Date,
  ) {
    const rows = await prisma.storefrontMetaTargetEvidenceDaily.findMany({
      where: { storeId, targetType, bucketDate: { gte: fromDate, lte: toDate } },
      distinct: ['metaAdId', 'targetKey'],
      select: { metaAdId: true, targetKey: true },
    });
    return rows.length;
  }

  async findTargetMetadata(storeId: string, metaAdIds: string[], targetKeys: string[]) {
    if (metaAdIds.length === 0 || targetKeys.length === 0) return [];
    const rows = await prisma.storefrontMetaTargetEvidenceDaily.findMany({
      where: { storeId, metaAdId: { in: metaAdIds }, targetKey: { in: targetKeys } },
      orderBy: [{ bucketDate: 'desc' }, { updatedAt: 'desc' }],
      select: {
        metaAdId: true,
        metaAdExternalId: true,
        targetType: true,
        targetKey: true,
        productId: true,
        collectionId: true,
        productExternalId: true,
        variantExternalId: true,
        collectionExternalId: true,
      },
    });
    const seen = new Set<string>();
    return rows.filter((row) => {
      const key = `${row.metaAdId}:${row.targetKey}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
  }

  findMetaAdsForDisplay(storeId: string, adIds: string[]) {
    if (adIds.length === 0) return Promise.resolve([]);
    return prisma.metaAd.findMany({
      where: { id: { in: adIds }, adAccount: { storeId } },
      select: {
        id: true,
        metaAdId: true,
        name: true,
        targetScope: true,
        targetScopeConfidence: true,
        effectiveStatus: true,
      },
    });
  }

  findProductsForDisplay(storeId: string, productIds: string[]) {
    if (productIds.length === 0) return Promise.resolve([]);
    return prisma.product.findMany({
      where: { storeId, id: { in: productIds } },
      select: { id: true, shopifyProductId: true, title: true, handle: true, deletedAt: true },
    });
  }

  findCollectionsForDisplay(storeId: string, collectionIds: string[]) {
    if (collectionIds.length === 0) return Promise.resolve([]);
    return prisma.collection.findMany({
      where: { storeId, id: { in: collectionIds } },
      select: { id: true, shopifyCollectionId: true, title: true, handle: true, deletedAt: true },
    });
  }

  findActiveMappings(storeId: string, metaAdIds: string[]) {
    if (metaAdIds.length === 0) return Promise.resolve({ products: [], collections: [] });
    return Promise.all([
      prisma.adProductMapping.findMany({
        where: { metaAdId: { in: metaAdIds }, validUntil: null, ad: { adAccount: { storeId } } },
        select: {
          metaAdId: true,
          productId: true,
          confidence: true,
          isMerchantConfirmed: true,
          source: true,
        },
      }),
      prisma.adCollectionMapping.findMany({
        where: { metaAdId: { in: metaAdIds }, validUntil: null, ad: { adAccount: { storeId } } },
        select: {
          metaAdId: true,
          collectionId: true,
          confidence: true,
          isMerchantConfirmed: true,
          source: true,
        },
      }),
    ]).then(([products, collections]) => ({ products, collections }));
  }
}
