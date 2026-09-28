import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import type { ConversionMatchKey, ConversionProviderCode } from './conversion-delivery.types.js';

const ALLOWED_CONSENT = ['GRANTED', 'NOT_REQUIRED'] as const;

export type ConversionCandidate = {
  orderId: string;
  shopifyOrderId: string;
  eventAt: Date;
  value: Prisma.Decimal;
  currencyCode: string;
  sourceEventAt: Date;
  sourceUrl: string;
  matchKeyKind: ConversionMatchKey;
  matchKey: string;
  consentState: 'GRANTED' | 'NOT_REQUIRED';
};

function providerEventId(shopifyOrderId: string): string {
  return shopifyOrderId.split('/').filter(Boolean).at(-1) ?? shopifyOrderId;
}

function sourceUrl(
  event: { landingPageUrl: string | null; pageUrl: string | null },
  store: { primaryDomainUrl: string | null; primaryDomainHost: string | null; myshopifyDomain: string },
) {
  const candidate = event.landingPageUrl ?? event.pageUrl ?? store.primaryDomainUrl;
  if (candidate) {
    try {
      const parsed = new URL(candidate);
      if (parsed.protocol === 'https:' || parsed.protocol === 'http:') return parsed.toString();
    } catch {
      // Fall through to the canonical store host.
    }
  }
  return `https://${store.primaryDomainHost ?? store.myshopifyDomain}/`;
}

function eventMatch(
  provider: ConversionProviderCode,
  event: {
    metaClickId: string | null;
    googleClickId: string | null;
    tiktokClickId: string | null;
    eventAt: Date;
  },
): { kind: ConversionMatchKey; value: string } | null {
  if (provider === 'META' && event.metaClickId) {
    return { kind: 'FBC', value: `fb.1.${event.eventAt.getTime()}.${event.metaClickId}` };
  }
  if (provider === 'TIKTOK' && event.tiktokClickId) {
    return { kind: 'TTCLID', value: event.tiktokClickId };
  }
  if (provider === 'GOOGLE_ADS' && event.googleClickId) {
    return { kind: 'GCLID', value: event.googleClickId };
  }
  return null;
}

function providerEventFilter(provider: ConversionProviderCode): Prisma.StorefrontEventWhereInput {
  if (provider === 'META') return { metaClickId: { not: null } };
  if (provider === 'TIKTOK') return { tiktokClickId: { not: null } };
  return { googleClickId: { not: null } };
}

export class ConversionDeliveryRepository {
  listDestinations(storeId: string) {
    return prisma.conversionDestination.findMany({
      where: { storeId },
      orderBy: [{ provider: 'asc' }, { accountExternalId: 'asc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        provider: true,
        accountExternalId: true,
        destinationExternalId: true,
        status: true,
        activeFrom: true,
        testEventCode: true,
        lastErrorCode: true,
        lastError: true,
        lastDeliveredAt: true,
        createdAt: true,
        updatedAt: true,
        _count: { select: { deliveries: true } },
      },
    });
  }

  findDestination(storeId: string, destinationId: string) {
    return prisma.conversionDestination.findFirst({
      where: { id: destinationId, storeId },
    });
  }

  findDestinationIdentity(input: {
    storeId: string;
    provider: ConversionProviderCode;
    accountExternalId: string;
    destinationExternalId: string;
  }) {
    return prisma.conversionDestination.findUnique({
      where: {
        storeId_provider_accountExternalId_destinationExternalId: input,
      },
    });
  }

  async upsertDestination(input: {
    storeId: string;
    provider: ConversionProviderCode;
    accountExternalId: string;
    destinationExternalId: string;
    secretCiphertext: string | null;
    testEventCode: string | null;
  }) {
    return prisma.conversionDestination.upsert({
      where: {
        storeId_provider_accountExternalId_destinationExternalId: {
          storeId: input.storeId,
          provider: input.provider,
          accountExternalId: input.accountExternalId,
          destinationExternalId: input.destinationExternalId,
        },
      },
      create: {
        ...input,
        status: 'PAUSED',
      },
      update: {
        secretCiphertext: input.secretCiphertext,
        testEventCode: input.testEventCode,
        status: 'PAUSED',
        lastErrorCode: null,
        lastError: null,
      },
    });
  }

  async activateDestination(storeId: string, destinationId: string, activeFrom: Date) {
    const destination = await prisma.conversionDestination.findFirst({
      where: { id: destinationId, storeId },
      select: { id: true, provider: true, accountExternalId: true },
    });
    if (!destination) return null;

    return prisma.$transaction(async (tx) => {
      await tx.conversionDestination.updateMany({
        where: {
          storeId,
          provider: destination.provider,
          accountExternalId: destination.accountExternalId,
          id: { not: destinationId },
          status: 'ACTIVE',
        },
        data: { status: 'PAUSED' },
      });
      return tx.conversionDestination.update({
        where: { id: destinationId },
        data: {
          status: 'ACTIVE',
          activeFrom,
          lastErrorCode: null,
          lastError: null,
        },
      });
    });
  }

  pauseDestination(storeId: string, destinationId: string) {
    return prisma.conversionDestination.updateMany({
      where: { id: destinationId, storeId },
      data: { status: 'PAUSED' },
    });
  }

  markDestinationError(destinationId: string, code: string, message: string) {
    return prisma.conversionDestination.update({
      where: { id: destinationId },
      data: { status: 'ERROR', lastErrorCode: code, lastError: message.slice(0, 4000) },
    });
  }

  activeDestinations(limit = 100) {
    return prisma.conversionDestination.findMany({
      where: { status: 'ACTIVE' },
      orderBy: [{ updatedAt: 'asc' }, { id: 'asc' }],
      take: limit,
    });
  }

  async findEligibleCandidates(
    destination: {
      id: string;
      storeId: string;
      provider: ConversionProviderCode;
      activeFrom: Date;
    },
    limit: number,
  ): Promise<ConversionCandidate[]> {
    const [orders, store] = await Promise.all([
      prisma.order.findMany({
        where: {
          storeId: destination.storeId,
          isTest: false,
          cancelledAt: null,
          currentTotalAmount: { not: null },
          shopifyCreatedAt: { gte: destination.activeFrom },
          conversionDeliveries: { none: { destinationId: destination.id } },
        },
        orderBy: [{ shopifyCreatedAt: 'asc' }, { id: 'asc' }],
        take: limit,
        select: {
          id: true,
          shopifyOrderId: true,
          shopifyCreatedAt: true,
          processedAt: true,
          currentTotalAmount: true,
          currencyCode: true,
        },
      }),
      prisma.store.findUnique({
        where: { id: destination.storeId },
        select: { primaryDomainUrl: true, primaryDomainHost: true, myshopifyDomain: true },
      }),
    ]);
    if (orders.length === 0 || !store) return [];

    const orderIds = orders.map((order) => order.id);
    const sessions = await prisma.storefrontSession.findMany({
      where: {
        storeId: destination.storeId,
        orderId: { in: orderIds },
        orderLinkStatus: 'LINKED',
      },
      orderBy: [{ checkoutCompletedAt: 'desc' }, { endedAt: 'desc' }, { id: 'desc' }],
      select: { id: true, orderId: true, browserSessionId: true },
    });
    const sessionByOrder = new Map<string, (typeof sessions)[number]>();
    for (const session of sessions) {
      if (session.orderId && !sessionByOrder.has(session.orderId)) {
        sessionByOrder.set(session.orderId, session);
      }
    }

    const sessionIds = [...sessionByOrder.values()].map((session) => session.browserSessionId);
    if (sessionIds.length === 0) return [];
    const events = await prisma.storefrontEvent.findMany({
      where: {
        storeId: destination.storeId,
        sessionId: { in: sessionIds },
        consentState: { in: [...ALLOWED_CONSENT] },
        ...providerEventFilter(destination.provider),
      },
      orderBy: [{ eventAt: 'asc' }, { receivedAt: 'asc' }, { id: 'asc' }],
      select: {
        sessionId: true,
        eventAt: true,
        consentState: true,
        pageUrl: true,
        landingPageUrl: true,
        metaClickId: true,
        googleClickId: true,
        tiktokClickId: true,
      },
    });
    const eventBySession = new Map<string, (typeof events)[number]>();
    for (const event of events) {
      if (event.sessionId && !eventBySession.has(event.sessionId)) {
        eventBySession.set(event.sessionId, event);
      }
    }

    return orders.flatMap((order) => {
      if (!order.currentTotalAmount) return [];
      const session = sessionByOrder.get(order.id);
      if (!session) return [];
      const event = eventBySession.get(session.browserSessionId);
      if (!event || (event.consentState !== 'GRANTED' && event.consentState !== 'NOT_REQUIRED')) {
        return [];
      }
      const match = eventMatch(destination.provider, event);
      if (!match) return [];
      const eventAt = order.processedAt ?? order.shopifyCreatedAt;
      if (event.eventAt > eventAt) return [];
      return [
        {
          orderId: order.id,
          shopifyOrderId: order.shopifyOrderId,
          eventAt,
          value: order.currentTotalAmount,
          currencyCode: order.currencyCode,
          sourceEventAt: event.eventAt,
          sourceUrl: sourceUrl(event, store),
          matchKeyKind: match.kind,
          matchKey: match.value,
          consentState: event.consentState,
        },
      ];
    });
  }

  createDeliveries(
    data: Array<{
      storeId: string;
      destinationId: string;
      sourceOrderId: string;
      eventKey: string;
      providerEventId: string;
      eventAt: Date;
      sourceEventAt: Date;
      value: Prisma.Decimal;
      currencyCode: string;
      sourceUrl: string;
      matchKeyKind: ConversionMatchKey;
      matchKeyCiphertext: string;
      consentState: 'GRANTED' | 'NOT_REQUIRED';
      nextAttemptAt: Date;
    }>,
  ) {
    if (data.length === 0) return Promise.resolve({ count: 0 });
    return prisma.conversionDelivery.createMany({ data, skipDuplicates: true });
  }

  async claimDue(now: Date, staleBefore: Date, limit: number) {
    return prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>`
        SELECT d."id"
        FROM "ConversionDelivery" d
        INNER JOIN "ConversionDestination" dest ON dest."id" = d."destinationId"
        WHERE dest."status" = 'ACTIVE'
          AND (
            (d."status" IN ('PENDING', 'RETRYING') AND d."nextAttemptAt" <= ${now})
            OR (d."status" = 'PROCESSING' AND d."processingStartedAt" <= ${staleBefore})
          )
        ORDER BY d."nextAttemptAt" ASC, d."createdAt" ASC, d."id" ASC
        LIMIT ${limit}
        FOR UPDATE OF d SKIP LOCKED
      `;
      if (rows.length === 0) return [];
      const ids = rows.map((row) => row.id);
      await tx.conversionDelivery.updateMany({
        where: { id: { in: ids } },
        data: {
          status: 'PROCESSING',
          processingStartedAt: now,
          attempts: { increment: 1 },
        },
      });
      return tx.conversionDelivery.findMany({
        where: { id: { in: ids } },
        include: {
          destination: true,
          store: {
            select: {
              id: true,
              myshopifyDomain: true,
              primaryDomainUrl: true,
              primaryDomainHost: true,
            },
          },
          sourceOrder: {
            include: {
              lineItems: {
                select: {
                  shopifyProductId: true,
                  shopifyVariantId: true,
                  sku: true,
                  quantity: true,
                  currentQuantity: true,
                  discountedUnitPriceAfterAllDiscounts: true,
                  originalUnitPrice: true,
                },
              },
            },
          },
        },
      });
    });
  }

  async markSent(deliveryId: string, destinationId: string, requestId: string | null, now: Date) {
    return prisma.$transaction([
      prisma.conversionDelivery.updateMany({
        where: { id: deliveryId, destinationId, status: 'PROCESSING' },
        data: {
          status: 'SENT',
          sentAt: now,
          processingStartedAt: null,
          providerRequestId: requestId,
          lastErrorCode: null,
          lastError: null,
        },
      }),
      prisma.conversionDestination.update({
        where: { id: destinationId },
        data: { lastDeliveredAt: now, lastErrorCode: null, lastError: null },
      }),
    ]);
  }

  markRetry(deliveryId: string, code: string, message: string, nextAttemptAt: Date) {
    return prisma.conversionDelivery.updateMany({
      where: { id: deliveryId, status: 'PROCESSING' },
      data: {
        status: 'RETRYING',
        nextAttemptAt,
        processingStartedAt: null,
        lastErrorCode: code,
        lastError: message.slice(0, 4000),
      },
    });
  }

  markDead(deliveryId: string, code: string, message: string, requestId: string | null) {
    return prisma.conversionDelivery.updateMany({
      where: { id: deliveryId, status: 'PROCESSING' },
      data: {
        status: 'DEAD',
        processingStartedAt: null,
        providerRequestId: requestId,
        lastErrorCode: code,
        lastError: message.slice(0, 4000),
      },
    });
  }

  retryDelivery(storeId: string, deliveryId: string, now: Date) {
    return prisma.conversionDelivery.updateMany({
      where: { id: deliveryId, storeId, status: { in: ['DEAD', 'RETRYING'] } },
      data: {
        status: 'PENDING',
        nextAttemptAt: now,
        processingStartedAt: null,
        lastErrorCode: null,
        lastError: null,
      },
    });
  }

  async listDeliveries(
    storeId: string,
    input: {
      destinationId?: string;
      status?: 'PENDING' | 'PROCESSING' | 'RETRYING' | 'SENT' | 'DEAD';
      page: number;
      limit: number;
    },
  ) {
    const where: Prisma.ConversionDeliveryWhereInput = {
      storeId,
      ...(input.destinationId ? { destinationId: input.destinationId } : {}),
      ...(input.status ? { status: input.status } : {}),
    };
    const [items, total] = await Promise.all([
      prisma.conversionDelivery.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (input.page - 1) * input.limit,
        take: input.limit,
        select: {
          id: true,
          eventKey: true,
          providerEventId: true,
          eventAt: true,
          value: true,
          currencyCode: true,
          matchKeyKind: true,
          consentState: true,
          status: true,
          attempts: true,
          nextAttemptAt: true,
          sentAt: true,
          providerRequestId: true,
          lastErrorCode: true,
          lastError: true,
          createdAt: true,
          updatedAt: true,
          destination: {
            select: {
              id: true,
              provider: true,
              accountExternalId: true,
              destinationExternalId: true,
              status: true,
            },
          },
          sourceOrder: { select: { name: true, shopifyOrderId: true } },
        },
      }),
      prisma.conversionDelivery.count({ where }),
    ]);
    return { items, total };
  }

  static eventKey(shopifyOrderId: string) {
    return `PURCHASE:${shopifyOrderId}`;
  }

  static providerEventId(shopifyOrderId: string) {
    return providerEventId(shopifyOrderId);
  }
}
