import type { Prisma, StorefrontBehaviorDimension } from '../../../generated/prisma/client.js';
import { prisma } from '../../../lib/prisma.js';

const BEHAVIOR_SUM_FIELDS = {
  sessionCount: true,
  pageViewCount: true,
  productViewCount: true,
  collectionViewCount: true,
  searchCount: true,
  addToCartCount: true,
  removeFromCartCount: true,
  productViewSessionCount: true,
  collectionViewSessionCount: true,
  searchSessionCount: true,
  addToCartSessionCount: true,
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
      SELECT DISTINCT s."storeId" AS "storeId"
      FROM "StorefrontSession" s
      LEFT JOIN "StorefrontBehaviorRollupState" r ON r."storeId" = s."storeId"
      WHERE r."rolledThroughMaterializedAt" IS NULL
         OR s."materializedAt" > r."rolledThroughMaterializedAt"
      ORDER BY s."storeId"
      LIMIT ${limit}
    `;
    return rows.map((row) => row.storeId);
  }

  findDirtySessions(storeId: string, after: Date | null, limit: number) {
    return prisma.storefrontSession.findMany({
      where: {
        storeId,
        ...(after ? { materializedAt: { gt: after } } : {}),
      },
      orderBy: [{ materializedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { id: true, startedAt: true, materializedAt: true },
    });
  }

  findSessionsForWindow(storeId: string, instantFrom: Date, instantTo: Date, skip: number, take: number) {
    return prisma.storefrontSession.findMany({
      where: { storeId, startedAt: { gte: instantFrom, lte: instantTo } },
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
      select: { id: true, shopifyProductId: true, title: true, handle: true, status: true, deletedAt: true },
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
