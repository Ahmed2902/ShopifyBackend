import { Prisma, type StorefrontBehaviorDimension } from '../../../generated/prisma/client.js';
import { withPostgresAdvisoryLock } from '../../../lib/postgres-advisory-lock.js';
import { prisma } from '../../../lib/prisma.js';

const BEHAVIOR_SUM_FIELDS = {
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

export type BehaviorDailyInput = Omit<
  Prisma.StorefrontBehaviorDailyCreateManyInput,
  'id' | 'createdAt' | 'updatedAt'
>;

export interface BehaviorDirtySession {
  id: string;
  startedAt: Date;
  previousStartedAt: Date | null;
  rollupDirtyAt: Date;
  orderUpdatedAt: Date | null;
  dirtyAt: Date;
}

export class PixelBehaviorRepository {
  getStoreContext(storeId: string) {
    return prisma.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        ianaTimezone: true,
        pixelInstallation: {
          select: { status: true, lastEventAt: true },
        },
        storefrontBehaviorRollup: {
          select: {
            rolledThroughMaterializedAt: true,
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
      LEFT JOIN "StorefrontBehaviorRollupState" r ON r."storeId" = s."storeId"
      WHERE s."behaviorRolledUpAt" IS NULL
         OR s."behaviorRolledUpAt" < s."rollupDirtyAt"
         OR s."behaviorRolledStartedAt" IS DISTINCT FROM s."startedAt"
         OR (o."id" IS NOT NULL AND o."updatedAt" > s."behaviorRolledUpAt")
      GROUP BY s."storeId", r."lastRolledUpAt", r."updatedAt"
      ORDER BY "lastAttemptAt" ASC, s."storeId" ASC
      LIMIT ${limit}
    `;
    return rows.map((row) => row.storeId);
  }

  withStoreRollupLock<T>(storeId: string, work: () => Promise<T>): Promise<T> {
    return withPostgresAdvisoryLock(`stride:pixel:behavior:${storeId}`, work);
  }

  findDirtySessions(storeId: string, limit: number) {
    return prisma.$queryRaw<BehaviorDirtySession[]>`
      SELECT
        s."id",
        s."startedAt",
        s."behaviorRolledStartedAt" AS "previousStartedAt",
        s."rollupDirtyAt" AS "rollupDirtyAt",
        o."updatedAt" AS "orderUpdatedAt",
        GREATEST(s."rollupDirtyAt", COALESCE(o."updatedAt", s."rollupDirtyAt")) AS "dirtyAt"
      FROM "StorefrontSession" s
      LEFT JOIN "Order" o ON o."id" = s."orderId"
      WHERE s."storeId" = ${storeId}::uuid
        AND (
          s."behaviorRolledUpAt" IS NULL
          OR s."behaviorRolledUpAt" < s."rollupDirtyAt"
          OR s."behaviorRolledStartedAt" IS DISTINCT FROM s."startedAt"
          OR (o."id" IS NOT NULL AND o."updatedAt" > s."behaviorRolledUpAt")
        )
      ORDER BY "dirtyAt" ASC, s."id" ASC
      LIMIT ${limit}
    `;
  }

  findSessionsForWindow(storeId: string, instantFrom: Date, instantTo: Date, skip: number, take: number) {
    return prisma.storefrontSession.findMany({
      where: {
        storeId,
        eventCount: { gt: 0 },
        startedAt: { gte: instantFrom, lte: instantTo },
      },
      orderBy: [{ startedAt: 'asc' }, { id: 'asc' }],
      skip,
      take,
      select: {
        id: true,
        startedAt: true,
        pageViewCount: true,
        productViewCount: true,
        collectionViewCount: true,
        searchCount: true,
        addToCartCount: true,
        removeFromCartCount: true,
        cartViewCount: true,
        checkoutStartedAt: true,
        checkoutCompletedAt: true,
        orderId: true,
        orderLinkStatus: true,
        landingPageUrl: true,
        products: {
          select: {
            identityKey: true,
            shopifyProductExternalId: true,
            shopifyVariantExternalId: true,
            productId: true,
            variantId: true,
            resolutionStatus: true,
            viewCount: true,
            addToCartCount: true,
            removeFromCartCount: true,
          },
        },
        collections: {
          select: {
            shopifyCollectionExternalId: true,
            collectionId: true,
            resolutionStatus: true,
            viewCount: true,
          },
        },
      },
    });
  }

  findValidOrders(storeId: string, orderIds: string[]) {
    if (orderIds.length === 0) return Promise.resolve([]);
    return prisma.order.findMany({
      where: {
        id: { in: orderIds },
        storeId,
        isTest: false,
        cancelledAt: null,
      },
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

  async replaceDailyRows(storeId: string, bucketDate: Date, rows: BehaviorDailyInput[]) {
    return prisma.$transaction(async (tx) => {
      await tx.storefrontBehaviorDaily.deleteMany({ where: { storeId, bucketDate } });
      if (rows.length > 0) {
        await tx.storefrontBehaviorDaily.createMany({ data: rows });
      }
      return { rows: rows.length };
    });
  }

  async acknowledgeSessions(storeId: string, sessions: BehaviorDirtySession[], acknowledgedAt: Date) {
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
        "behaviorRolledUpAt" = ${acknowledgedAt},
        "behaviorRolledStartedAt" = s."startedAt",
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
    return prisma.storefrontBehaviorRollupState.upsert({
      where: { storeId },
      create: {
        storeId,
        rolledThroughMaterializedAt: watermark,
        lastRolledUpAt: rolledUpAt,
        lastError: null,
      },
      update: {
        rolledThroughMaterializedAt: watermark,
        lastRolledUpAt: rolledUpAt,
        lastError: null,
      },
      select: { storeId: true },
    });
  }

  recordRollupError(storeId: string, message: string) {
    return prisma.storefrontBehaviorRollupState.upsert({
      where: { storeId },
      create: { storeId, lastError: message },
      update: { lastError: message },
      select: { storeId: true },
    });
  }

  aggregateStore(storeId: string, fromDate: Date, toDate: Date) {
    return prisma.storefrontBehaviorDaily.aggregate({
      where: {
        storeId,
        dimension: 'STORE',
        dimensionKey: 'store',
        bucketDate: { gte: fromDate, lte: toDate },
      },
      _sum: BEHAVIOR_SUM_FIELDS,
    });
  }

  aggregateProduct(storeId: string, productId: string, fromDate: Date, toDate: Date) {
    return prisma.storefrontBehaviorDaily.aggregate({
      where: {
        storeId,
        dimension: 'PRODUCT',
        productId,
        bucketDate: { gte: fromDate, lte: toDate },
      },
      _sum: BEHAVIOR_SUM_FIELDS,
    });
  }

  aggregateCollection(storeId: string, collectionId: string, fromDate: Date, toDate: Date) {
    return prisma.storefrontBehaviorDaily.aggregate({
      where: {
        storeId,
        dimension: 'COLLECTION',
        collectionId,
        bucketDate: { gte: fromDate, lte: toDate },
      },
      _sum: BEHAVIOR_SUM_FIELDS,
    });
  }

  groupDimension(
    storeId: string,
    dimension: Exclude<StorefrontBehaviorDimension, 'STORE'>,
    fromDate: Date,
    toDate: Date,
    page: number,
    limit: number,
  ) {
    return prisma.storefrontBehaviorDaily.groupBy({
      by: ['dimensionKey'],
      where: { storeId, dimension, bucketDate: { gte: fromDate, lte: toDate } },
      _sum: BEHAVIOR_SUM_FIELDS,
      orderBy: [{ _sum: { sessionCount: 'desc' } }, { dimensionKey: 'asc' }],
      skip: (page - 1) * limit,
      take: limit,
    });
  }

  groupDimensionKeys(
    storeId: string,
    dimension: Exclude<StorefrontBehaviorDimension, 'STORE'>,
    dimensionKeys: string[],
    fromDate: Date,
    toDate: Date,
  ) {
    if (dimensionKeys.length === 0) return Promise.resolve([]);
    return prisma.storefrontBehaviorDaily.groupBy({
      by: ['dimensionKey'],
      where: {
        storeId,
        dimension,
        dimensionKey: { in: dimensionKeys },
        bucketDate: { gte: fromDate, lte: toDate },
      },
      _sum: BEHAVIOR_SUM_FIELDS,
    });
  }

  async countDimensionKeys(
    storeId: string,
    dimension: Exclude<StorefrontBehaviorDimension, 'STORE'>,
    fromDate: Date,
    toDate: Date,
  ) {
    const rows = await prisma.storefrontBehaviorDaily.findMany({
      where: { storeId, dimension, bucketDate: { gte: fromDate, lte: toDate } },
      distinct: ['dimensionKey'],
      select: { dimensionKey: true },
    });
    return rows.length;
  }

  async findDimensionMetadata(
    storeId: string,
    dimension: Exclude<StorefrontBehaviorDimension, 'STORE'>,
    dimensionKeys: string[],
  ) {
    if (dimensionKeys.length === 0) return [];
    const rows = await prisma.storefrontBehaviorDaily.findMany({
      where: { storeId, dimension, dimensionKey: { in: dimensionKeys } },
      orderBy: [{ bucketDate: 'desc' }, { updatedAt: 'desc' }],
      select: {
        dimensionKey: true,
        productId: true,
        variantId: true,
        collectionId: true,
        productExternalId: true,
        variantExternalId: true,
        collectionExternalId: true,
        landingPageHash: true,
        landingPageUrl: true,
      },
    });
    const seen = new Set<string>();
    return rows.filter((row) => {
      if (seen.has(row.dimensionKey)) return false;
      seen.add(row.dimensionKey);
      return true;
    });
  }

  findProductsForDisplay(storeId: string, productIds: string[]) {
    if (productIds.length === 0) return Promise.resolve([]);
    return prisma.product.findMany({
      where: { storeId, id: { in: productIds } },
      select: {
        id: true,
        shopifyProductId: true,
        title: true,
        handle: true,
        status: true,
        deletedAt: true,
      },
    });
  }

  findCollectionsForDisplay(storeId: string, collectionIds: string[]) {
    if (collectionIds.length === 0) return Promise.resolve([]);
    return prisma.collection.findMany({
      where: { storeId, id: { in: collectionIds } },
      select: { id: true, shopifyCollectionId: true, title: true, handle: true, deletedAt: true },
    });
  }
}
