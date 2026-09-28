import type { AdvertisingProvider, ConversionDeliveryStatus, Prisma } from '../../generated/prisma/client.js';
import { Prisma as PrismaSql } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import type { ConfigureDestinationInput, PurchaseCandidate } from './conversion-delivery.types.js';

const PUBLIC_DESTINATION_SELECT = {
  id: true,
  storeId: true,
  provider: true,
  externalId: true,
  displayName: true,
  configJson: true,
  status: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ConversionDestinationSelect;

export class ConversionDeliveryRepository {
  listDestinations(storeId: string) {
    return prisma.conversionDestination.findMany({
      where: { storeId },
      orderBy: [{ provider: 'asc' }, { createdAt: 'asc' }],
      select: PUBLIC_DESTINATION_SELECT,
    });
  }

  getDestination(storeId: string, destinationId: string) {
    return prisma.conversionDestination.findFirst({
      where: { id: destinationId, storeId },
      select: PUBLIC_DESTINATION_SELECT,
    });
  }

  findDestinationWithSecret(storeId: string, destinationId: string) {
    return prisma.conversionDestination.findFirst({
      where: { id: destinationId, storeId },
    });
  }

  async upsertDestination(
    storeId: string,
    input: ConfigureDestinationInput,
    accessTokenCiphertext: string | undefined,
  ) {
    const existing = await prisma.conversionDestination.findUnique({
      where: {
        storeId_provider_externalId: {
          storeId,
          provider: input.provider,
          externalId: input.externalId,
        },
      },
      select: { id: true },
    });

    const data = {
      displayName: input.displayName ?? null,
      configJson: input.config as Prisma.InputJsonValue,
      status: 'ACTIVE' as const,
      ...(accessTokenCiphertext ? { accessTokenCiphertext } : {}),
    };

    if (existing) {
      return prisma.conversionDestination.update({
        where: { id: existing.id },
        data,
        select: PUBLIC_DESTINATION_SELECT,
      });
    }

    return prisma.conversionDestination.create({
      data: {
        storeId,
        provider: input.provider,
        externalId: input.externalId,
        ...data,
        accessTokenCiphertext: accessTokenCiphertext ?? null,
      },
      select: PUBLIC_DESTINATION_SELECT,
    });
  }

  disableDestination(storeId: string, destinationId: string) {
    return prisma.conversionDestination.updateMany({
      where: { id: destinationId, storeId },
      data: { status: 'DISABLED' },
    });
  }

  activeDestinations() {
    return prisma.conversionDestination.findMany({
      where: { status: 'ACTIVE' },
      orderBy: [{ storeId: 'asc' }, { provider: 'asc' }],
    });
  }

  async findPurchaseCandidates(limit: number): Promise<PurchaseCandidate[]> {
    return prisma.$queryRaw<PurchaseCandidate[]>(PrismaSql.sql`
      SELECT DISTINCT ON (o."id")
        o."id" AS "orderId",
        o."storeId" AS "storeId",
        o."shopifyOrderId" AS "shopifyOrderId",
        COALESCE(o."processedAt", o."shopifyCreatedAt") AS "eventAt",
        o."currentTotalAmount"::text AS "value",
        o."currencyCode" AS "currencyCode",
        COALESCE(s."landingPageUrl", st."primaryDomainUrl") AS "eventSourceUrl",
        meta_event."metaClickId" AS "metaClickId",
        meta_event."eventAt" AS "metaClickEventAt",
        google_event."googleClickId" AS "googleClickId",
        google_event."eventAt" AS "googleClickEventAt",
        tiktok_event."tiktokClickId" AS "tiktokClickId",
        tiktok_event."eventAt" AS "tiktokClickEventAt"
      FROM "Order" o
      JOIN "Store" st ON st."id" = o."storeId"
      JOIN "StorefrontSession" s
        ON s."orderId" = o."id"
       AND s."orderLinkStatus" = 'LINKED'
      LEFT JOIN LATERAL (
        SELECT e."metaClickId", e."eventAt"
        FROM "StorefrontEvent" e
        WHERE e."storeId" = o."storeId"
          AND e."sessionId" = s."browserSessionId"
          AND e."metaClickId" IS NOT NULL
          AND e."consentState" IN ('GRANTED', 'NOT_REQUIRED')
        ORDER BY e."eventAt" DESC, e."receivedAt" DESC
        LIMIT 1
      ) meta_event ON TRUE
      LEFT JOIN LATERAL (
        SELECT e."googleClickId", e."eventAt"
        FROM "StorefrontEvent" e
        WHERE e."storeId" = o."storeId"
          AND e."sessionId" = s."browserSessionId"
          AND e."googleClickId" IS NOT NULL
          AND e."consentState" IN ('GRANTED', 'NOT_REQUIRED')
        ORDER BY e."eventAt" DESC, e."receivedAt" DESC
        LIMIT 1
      ) google_event ON TRUE
      LEFT JOIN LATERAL (
        SELECT e."tiktokClickId", e."eventAt"
        FROM "StorefrontEvent" e
        WHERE e."storeId" = o."storeId"
          AND e."sessionId" = s."browserSessionId"
          AND e."tiktokClickId" IS NOT NULL
          AND e."consentState" IN ('GRANTED', 'NOT_REQUIRED')
        ORDER BY e."eventAt" DESC, e."receivedAt" DESC
        LIMIT 1
      ) tiktok_event ON TRUE
      WHERE o."isTest" = FALSE
        AND o."cancelledAt" IS NULL
        AND o."currentTotalAmount" IS NOT NULL
        AND COALESCE(o."processedAt", o."shopifyCreatedAt") >= NOW() - INTERVAL '30 days'
        AND (
          meta_event."metaClickId" IS NOT NULL
          OR google_event."googleClickId" IS NOT NULL
          OR tiktok_event."tiktokClickId" IS NOT NULL
        )
      ORDER BY o."id", s."endedAt" DESC, s."id" DESC
      LIMIT ${limit}
    `);
  }

  async enqueue(input: {
    storeId: string;
    destinationId: string;
    provider: AdvertisingProvider;
    eventKey: string;
    sourceOrderId: string;
    shopifyOrderId: string;
    eventAt: Date;
    value: string;
    currencyCode: string;
    clickId: string;
    attributionEventAt: Date | null;
    eventSourceUrl: string | null;
  }) {
    const existing = await prisma.conversionDelivery.findUnique({
      where: {
        destinationId_eventKey: {
          destinationId: input.destinationId,
          eventKey: input.eventKey,
        },
      },
      select: { id: true, status: true },
    });
    if (existing) return { ...existing, created: false };

    const created = await prisma.conversionDelivery.create({
      data: { ...input, eventName: 'PURCHASE' },
      select: { id: true, status: true },
    });
    return { ...created, created: true };
  }

  async recoverStaleClaims(cutoff: Date) {
    return prisma.conversionDelivery.updateMany({
      where: { status: 'PROCESSING', processingStartedAt: { lt: cutoff } },
      data: {
        status: 'RETRY',
        processingStartedAt: null,
        nextAttemptAt: new Date(),
        lastError: 'Recovered stale conversion-delivery claim',
      },
    });
  }

  async claimDue(limit: number, now: Date) {
    return prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<Array<{ id: string }>>(PrismaSql.sql`
        SELECT d."id"
        FROM "ConversionDelivery" d
        JOIN "ConversionDestination" dest ON dest."id" = d."destinationId"
        JOIN "StoreSubscription" sub ON sub."storeId" = d."storeId"
        WHERE d."status" IN ('PENDING', 'RETRY')
          AND d."nextAttemptAt" <= ${now}
          AND dest."status" = 'ACTIVE'
          AND sub."status" IN ('TRIALING', 'ACTIVE')
          AND (
            sub."selectedPlan" = 'PRO'
            OR (
              sub."selectedPlan" = 'ESSENTIALS'
              AND sub."essentialsAdProvider" IS NOT NULL
              AND sub."essentialsAdProvider"::text = d."provider"::text
            )
          )
        ORDER BY d."nextAttemptAt" ASC, d."createdAt" ASC, d."id" ASC
        LIMIT ${limit}
        FOR UPDATE OF d SKIP LOCKED
      `);
      if (rows.length === 0) return [];
      const ids = rows.map((row) => row.id);
      await tx.conversionDelivery.updateMany({
        where: { id: { in: ids } },
        data: { status: 'PROCESSING', processingStartedAt: now },
      });
      return tx.conversionDelivery.findMany({
        where: { id: { in: ids } },
        include: { destination: true },
        orderBy: { createdAt: 'asc' },
      });
    });
  }

  markDelivered(id: string, providerRequestId: string | null, deliveredAt: Date) {
    return prisma.conversionDelivery.update({
      where: { id },
      data: {
        status: 'DELIVERED',
        attempts: { increment: 1 },
        processingStartedAt: null,
        deliveredAt,
        providerRequestId,
        lastError: null,
        clickId: null,
        attributionEventAt: null,
        eventSourceUrl: null,
      },
    });
  }

  markFailed(
    id: string,
    status: Extract<ConversionDeliveryStatus, 'RETRY' | 'DEAD'>,
    nextAttemptAt: Date,
    error: string,
  ) {
    return prisma.conversionDelivery.update({
      where: { id },
      data: {
        status,
        attempts: { increment: 1 },
        processingStartedAt: null,
        nextAttemptAt,
        lastError: error.slice(0, 2_000),
      },
    });
  }

  listDeliveries(
    storeId: string,
    input: { provider?: AdvertisingProvider; status?: ConversionDeliveryStatus; limit: number },
  ) {
    return prisma.conversionDelivery.findMany({
      where: {
        storeId,
        ...(input.provider ? { provider: input.provider } : {}),
        ...(input.status ? { status: input.status } : {}),
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: input.limit,
      select: {
        id: true,
        provider: true,
        eventKey: true,
        eventName: true,
        shopifyOrderId: true,
        eventAt: true,
        value: true,
        currencyCode: true,
        status: true,
        attempts: true,
        nextAttemptAt: true,
        deliveredAt: true,
        providerRequestId: true,
        lastError: true,
        createdAt: true,
        destination: { select: { id: true, externalId: true, displayName: true } },
      },
    });
  }
}
