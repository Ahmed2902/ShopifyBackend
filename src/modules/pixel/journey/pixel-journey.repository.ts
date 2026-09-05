import type { Prisma } from '../../../generated/prisma/client.js';
import { prisma } from '../../../lib/prisma.js';
import type { StorefrontJourneySource } from '../pixel.types.js';

export interface SessionAggregateInput {
  anonymousVisitorId: string | null;
  startedAt: Date;
  endedAt: Date;
  lastSourceReceivedAt: Date;
  eventCount: number;
  pageViewCount: number;
  productViewCount: number;
  collectionViewCount: number;
  searchCount: number;
  addToCartCount: number;
  removeFromCartCount: number;
  checkoutProgressCount: number;
  checkoutStartedAt: Date | null;
  checkoutCompletedAt: Date | null;
  shopifyCheckoutToken: string | null;
  shopifyOrderExternalId: string | null;
  orderId: string | null;
  orderLinkStatus: 'NONE' | 'PENDING' | 'LINKED';
  orderLinkAttemptCount: number;
  orderLinkNextAttemptAt: Date | null;
  landingPageUrl: string | null;
  initialReferrerUrl: string | null;
  dataQualityFlags: string[];
  retentionExpiresAt: Date;
  materializedAt: Date;
  rollupDirtyAt: Date;
}

export type SessionTouchInput = Omit<
  Prisma.StorefrontSessionTouchCreateManyInput,
  'id' | 'sessionId' | 'createdAt'
>;
export type SessionProductInput = Omit<
  Prisma.StorefrontSessionProductCreateManyInput,
  'id' | 'sessionId' | 'createdAt'
>;
export type SessionCollectionInput = Omit<
  Prisma.StorefrontSessionCollectionCreateManyInput,
  'id' | 'sessionId' | 'createdAt'
>;

export class PixelJourneyRepository {
  findSessionEvents(storeId: string, browserSessionId: string) {
    return prisma.storefrontEvent.findMany({
      where: { storeId, sessionId: browserSessionId },
      orderBy: [{ eventAt: 'asc' }, { receivedAt: 'asc' }, { eventId: 'asc' }],
      select: {
        id: true,
        eventId: true,
        eventName: true,
        eventAt: true,
        receivedAt: true,
        anonymousVisitorId: true,
        pageUrl: true,
        referrerUrl: true,
        landingPageUrl: true,
        productExternalId: true,
        variantExternalId: true,
        collectionExternalId: true,
        quantity: true,
        shopifyCheckoutToken: true,
        shopifyOrderExternalId: true,
        utmSource: true,
        utmMedium: true,
        utmCampaign: true,
        utmContent: true,
        utmTerm: true,
        metaClickId: true,
        googleClickId: true,
        tiktokClickId: true,
        metaCampaignExternalId: true,
        metaAdSetExternalId: true,
        metaAdExternalId: true,
        retentionExpiresAt: true,
      },
    });
  }

  async resolveMetaHierarchy(
    storeId: string,
    input: { campaignIds: string[]; adSetIds: string[]; adIds: string[] },
  ) {
    const [campaigns, adSets, ads] = await Promise.all([
      input.campaignIds.length === 0
        ? Promise.resolve([])
        : prisma.metaCampaign.findMany({
            where: {
              metaCampaignId: { in: input.campaignIds },
              deletedAt: null,
              adAccount: { storeId },
            },
            select: { id: true, metaCampaignId: true },
          }),
      input.adSetIds.length === 0
        ? Promise.resolve([])
        : prisma.metaAdSet.findMany({
            where: {
              metaAdSetId: { in: input.adSetIds },
              deletedAt: null,
              adAccount: { storeId },
            },
            select: {
              id: true,
              metaAdSetId: true,
              campaign: { select: { id: true, metaCampaignId: true } },
            },
          }),
      input.adIds.length === 0
        ? Promise.resolve([])
        : prisma.metaAd.findMany({
            where: {
              metaAdId: { in: input.adIds },
              deletedAt: null,
              adAccount: { storeId },
            },
            select: {
              id: true,
              metaAdId: true,
              campaign: { select: { id: true, metaCampaignId: true } },
              adSet: { select: { id: true, metaAdSetId: true } },
            },
          }),
    ]);
    return { campaigns, adSets, ads };
  }

  async resolveCommerceEntities(
    storeId: string,
    input: { productIds: string[]; variantIds: string[]; collectionIds: string[] },
  ) {
    const [products, variants, collections] = await Promise.all([
      input.productIds.length === 0
        ? Promise.resolve([])
        : prisma.product.findMany({
            where: { storeId, shopifyProductId: { in: input.productIds }, deletedAt: null },
            select: { id: true, shopifyProductId: true },
          }),
      input.variantIds.length === 0
        ? Promise.resolve([])
        : prisma.productVariant.findMany({
            where: { storeId, shopifyVariantId: { in: input.variantIds }, deletedAt: null },
            select: {
              id: true,
              shopifyVariantId: true,
              product: { select: { id: true, shopifyProductId: true } },
            },
          }),
      input.collectionIds.length === 0
        ? Promise.resolve([])
        : prisma.collection.findMany({
            where: {
              storeId,
              shopifyCollectionId: { in: input.collectionIds },
              deletedAt: null,
            },
            select: { id: true, shopifyCollectionId: true },
          }),
    ]);
    return { products, variants, collections };
  }

  findOrderByExternalId(storeId: string, shopifyOrderId: string) {
    return prisma.order.findUnique({
      where: { storeId_shopifyOrderId: { storeId, shopifyOrderId } },
      select: { id: true, shopifyOrderId: true },
    });
  }

  async replaceSessionReadModel(
    storeId: string,
    browserSessionId: string,
    expectedRepairMarkerId: string,
    aggregate: SessionAggregateInput,
    touches: SessionTouchInput[],
    products: SessionProductInput[],
    collections: SessionCollectionInput[],
  ) {
    return prisma.$transaction(async (tx) => {
      // Claim exactly the repair generation that was observed before reading raw events. If a
      // newer ingestion rotated the marker—or another materializer already claimed this one—this
      // stale materialization must not overwrite the read model. The marker delete and read-model
      // replacement commit atomically in the same transaction.
      const claimed = await tx.storefrontSessionRepair.deleteMany({
        where: {
          id: expectedRepairMarkerId,
          storeId,
          browserSessionId,
        },
      });
      if (claimed.count === 0) return null;

      const session = await tx.storefrontSession.upsert({
        where: { storeId_browserSessionId: { storeId, browserSessionId } },
        create: { storeId, browserSessionId, ...aggregate },
        update: aggregate,
        select: { id: true },
      });

      await tx.storefrontSessionTouch.deleteMany({ where: { sessionId: session.id } });
      await tx.storefrontSessionProduct.deleteMany({ where: { sessionId: session.id } });
      await tx.storefrontSessionCollection.deleteMany({ where: { sessionId: session.id } });

      if (touches.length > 0) {
        await tx.storefrontSessionTouch.createMany({
          data: touches.map((touch) => ({ ...touch, sessionId: session.id })),
        });
      }
      if (products.length > 0) {
        await tx.storefrontSessionProduct.createMany({
          data: products.map((product) => ({ ...product, sessionId: session.id })),
        });
      }
      if (collections.length > 0) {
        await tx.storefrontSessionCollection.createMany({
          data: collections.map((collection) => ({ ...collection, sessionId: session.id })),
        });
      }

      return session;
    });
  }

  findSessionRepairMarker(storeId: string, browserSessionId: string) {
    return prisma.storefrontSessionRepair.findUnique({
      where: { storeId_browserSessionId: { storeId, browserSessionId } },
      select: { id: true },
    });
  }

  clearSessionRepair(storeId: string, browserSessionId: string, expectedMarkerId: string) {
    return prisma.storefrontSessionRepair.deleteMany({
      where: {
        id: expectedMarkerId,
        storeId,
        browserSessionId,
      },
    });
  }

  findDirtySessionKeys(limit: number) {
    return prisma.storefrontSessionRepair.findMany({
      orderBy: [{ sourceReceivedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: { storeId: true, browserSessionId: true },
    });
  }

  findPendingOrderSessions(now: Date, limit: number) {
    return prisma.storefrontSession.findMany({
      where: {
        orderLinkStatus: 'PENDING',
        shopifyOrderExternalId: { not: null },
        OR: [{ orderLinkNextAttemptAt: null }, { orderLinkNextAttemptAt: { lte: now } }],
      },
      orderBy: [{ orderLinkNextAttemptAt: 'asc' }, { checkoutCompletedAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        storeId: true,
        shopifyOrderExternalId: true,
        orderLinkAttemptCount: true,
      },
    });
  }

  setOrderLink(sessionId: string, orderId: string, dirtyAt: Date) {
    return prisma.storefrontSession.update({
      where: { id: sessionId },
      data: {
        orderId,
        orderLinkStatus: 'LINKED',
        orderLinkAttemptCount: 0,
        orderLinkNextAttemptAt: null,
        rollupDirtyAt: dirtyAt,
      },
      select: { id: true },
    });
  }

  scheduleOrderLinkRetry(sessionId: string, attemptCount: number, nextAttemptAt: Date) {
    return prisma.storefrontSession.update({
      where: { id: sessionId },
      data: {
        orderLinkAttemptCount: attemptCount,
        orderLinkNextAttemptAt: nextAttemptAt,
      },
      select: { id: true },
    });
  }

  async deleteExpiredSessions(now: Date, limit: number) {
    const rows = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT s."id"
      FROM "StorefrontSession" s
      LEFT JOIN "Order" o ON o."id" = s."orderId"
      WHERE s."retentionExpiresAt" <= ${now}
        AND s."behaviorRolledUpAt" IS NOT NULL
        AND s."attributionRolledUpAt" IS NOT NULL
        AND s."behaviorRolledUpAt" >= s."rollupDirtyAt"
        AND s."attributionRolledUpAt" >= s."rollupDirtyAt"
        AND s."behaviorRolledStartedAt" = s."startedAt"
        AND s."attributionRolledStartedAt" = s."startedAt"
        AND (
          o."id" IS NULL
          OR (
            o."updatedAt" <= s."behaviorRolledUpAt"
            AND o."updatedAt" <= s."attributionRolledUpAt"
          )
        )
      ORDER BY s."retentionExpiresAt" ASC, s."id" ASC
      LIMIT ${limit}
    `;
    if (rows.length === 0) return { selected: 0, deleted: 0 };
    const result = await prisma.storefrontSession.deleteMany({
      where: { id: { in: rows.map((row) => row.id) } },
    });
    return { selected: rows.length, deleted: result.count };
  }

  async listSessions(
    storeId: string,
    input: {
      from?: Date;
      to?: Date;
      source?: StorefrontJourneySource;
      metaAdExternalId?: string;
      productExternalId?: string;
      checkoutCompleted?: boolean;
      page: number;
      limit: number;
    },
  ) {
    const touchFilter: Prisma.StorefrontSessionTouchWhereInput = {
      ...(input.source ? { source: input.source } : {}),
      ...(input.metaAdExternalId ? { metaAdExternalId: input.metaAdExternalId } : {}),
    };
    const hasTouchFilter = Boolean(input.source || input.metaAdExternalId);
    const where: Prisma.StorefrontSessionWhereInput = {
      storeId,
      ...(input.from || input.to
        ? {
            startedAt: {
              ...(input.from ? { gte: input.from } : {}),
              ...(input.to ? { lte: input.to } : {}),
            },
          }
        : {}),
      ...(hasTouchFilter ? { touches: { some: touchFilter } } : {}),
      ...(input.productExternalId
        ? { products: { some: { shopifyProductExternalId: input.productExternalId } } }
        : {}),
      ...(input.checkoutCompleted === undefined
        ? {}
        : input.checkoutCompleted
          ? { checkoutCompletedAt: { not: null } }
          : { checkoutCompletedAt: null }),
    };

    const [items, total] = await prisma.$transaction([
      prisma.storefrontSession.findMany({
        where,
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        skip: (input.page - 1) * input.limit,
        take: input.limit,
        include: {
          touches: { orderBy: { ordinal: 'asc' } },
          products: { orderBy: { firstSeenAt: 'asc' } },
          collections: { orderBy: { firstSeenAt: 'asc' } },
        },
      }),
      prisma.storefrontSession.count({ where }),
    ]);
    return { items, total };
  }

  getSession(storeId: string, sessionId: string) {
    return prisma.storefrontSession.findFirst({
      where: { id: sessionId, storeId },
      include: {
        touches: { orderBy: { ordinal: 'asc' } },
        products: { orderBy: { firstSeenAt: 'asc' } },
        collections: { orderBy: { firstSeenAt: 'asc' } },
      },
    });
  }

  getSessionTimeline(storeId: string, browserSessionId: string) {
    return prisma.storefrontEvent.findMany({
      where: { storeId, sessionId: browserSessionId },
      orderBy: [{ eventAt: 'asc' }, { receivedAt: 'asc' }, { eventId: 'asc' }],
      select: {
        eventId: true,
        eventName: true,
        eventAt: true,
        pageUrl: true,
        productExternalId: true,
        variantExternalId: true,
        collectionExternalId: true,
        quantity: true,
        shopifyOrderExternalId: true,
      },
    });
  }

  async listVisitorSessions(storeId: string, anonymousVisitorId: string, limit: number) {
    const rows = await prisma.storefrontSession.findMany({
      where: { storeId, anonymousVisitorId },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      take: limit,
      include: {
        touches: { orderBy: { ordinal: 'asc' } },
        products: { orderBy: { firstSeenAt: 'asc' } },
        collections: { orderBy: { firstSeenAt: 'asc' } },
      },
    });
    return rows.reverse();
  }

  findDisplayEntities(
    storeId: string,
    input: {
      orderIds: string[];
      metaAdIds: string[];
      productIds: string[];
      variantIds: string[];
      collectionIds: string[];
    },
  ) {
    return Promise.all([
      input.orderIds.length === 0
        ? Promise.resolve([])
        : prisma.order.findMany({
            where: { storeId, id: { in: input.orderIds } },
            select: {
              id: true,
              shopifyOrderId: true,
              name: true,
              shopifyCreatedAt: true,
              currentTotalAmount: true,
              currencyCode: true,
              isTest: true,
              cancelledAt: true,
            },
          }),
      input.metaAdIds.length === 0
        ? Promise.resolve([])
        : prisma.metaAd.findMany({
            where: { id: { in: input.metaAdIds }, adAccount: { storeId } },
            select: {
              id: true,
              metaAdId: true,
              name: true,
              effectiveStatus: true,
              campaign: { select: { id: true, metaCampaignId: true, name: true } },
              adSet: { select: { id: true, metaAdSetId: true, name: true } },
            },
          }),
      input.productIds.length === 0
        ? Promise.resolve([])
        : prisma.product.findMany({
            where: { storeId, id: { in: input.productIds } },
            select: { id: true, shopifyProductId: true, title: true, handle: true },
          }),
      input.variantIds.length === 0
        ? Promise.resolve([])
        : prisma.productVariant.findMany({
            where: { storeId, id: { in: input.variantIds } },
            select: { id: true, shopifyVariantId: true, title: true, sku: true, productId: true },
          }),
      input.collectionIds.length === 0
        ? Promise.resolve([])
        : prisma.collection.findMany({
            where: { storeId, id: { in: input.collectionIds } },
            select: { id: true, shopifyCollectionId: true, title: true, handle: true },
          }),
    ]);
  }
}
