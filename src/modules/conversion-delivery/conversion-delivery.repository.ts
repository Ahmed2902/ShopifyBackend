import type {
  AdvertisingProvider,
  ConversionDeliveryStatus,
  Prisma,
} from '../../generated/prisma/client.js';
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
    accessTokenCiphertext: string | null | undefined,
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
      ...(input.config.authSource === 'META_CONNECTION'
        ? { accessTokenCiphertext: null }
        : accessTokenCiphertext !== undefined
          ? { accessTokenCiphertext }
          : {}),
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

  async findPurchaseCandidates(
    limit: number,
    sourceOrderId?: string,
  ): Promise<PurchaseCandidate[]> {
    return prisma.$queryRaw<PurchaseCandidate[]>(PrismaSql.sql`
      SELECT DISTINCT ON (o."id")
        identity_event."id" AS "sourceEventId",
        conn."installedAt" AS "sourceGenerationAt",
        (identity_event."browserMatchCiphertext" IS NOT NULL AND identity_event."browserMatchExpiresAt" > NOW()) AS "browserMatchAvailable",
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
        google_event."googleClickIdKind" AS "googleClickIdKind",
        google_event."eventAt" AS "googleClickEventAt",
        tiktok_event."tiktokClickId" AS "tiktokClickId",
        tiktok_event."eventAt" AS "tiktokClickEventAt"
      FROM "Order" o
      JOIN "Store" st ON st."id" = o."storeId"
      JOIN "ShopifyConnection" conn ON conn."storeId" = o."storeId" AND conn."status" = 'ACTIVE'
      JOIN "StorefrontSession" s
        ON s."orderId" = o."id"
       AND s."orderLinkStatus" = 'LINKED'
      JOIN LATERAL (
        SELECT e."id", e."browserMatchCiphertext", e."browserMatchExpiresAt"
        FROM "StorefrontEvent" e WHERE e."storeId" = o."storeId" AND e."sessionId" = s."browserSessionId"
          AND e."eventAt" >= conn."installedAt" AND e."eventAt" <= COALESCE(o."processedAt", o."shopifyCreatedAt") + INTERVAL '10 minutes'
          AND e."adSharingAllowed" = TRUE AND e."consentState" IN ('GRANTED', 'NOT_REQUIRED')
          AND NOT EXISTS (SELECT 1 FROM "StorefrontConsentWithdrawal" w WHERE w."storeId" = e."storeId" AND e."eventAt" <= w."revokedBefore" AND (w."scopeKey" = 'session:' || e."sessionId" OR w."scopeKey" = 'visitor:' || e."anonymousVisitorId"))
        ORDER BY (e."shopifyOrderExternalId" = o."shopifyOrderId" AND e."shopifyCheckoutToken" IS NOT NULL) DESC NULLS LAST, e."eventAt" DESC, e."receivedAt" DESC LIMIT 1
      ) identity_event ON TRUE
      LEFT JOIN LATERAL (
        SELECT e."metaClickId", e."eventAt"
        FROM "StorefrontEvent" e
        WHERE e."storeId" = o."storeId"
          AND (e."sessionId" = s."browserSessionId" OR (s."anonymousVisitorId" IS NOT NULL AND e."anonymousVisitorId" = s."anonymousVisitorId"))
          AND e."eventAt" >= conn."installedAt"
          AND e."eventAt" >= COALESCE(o."processedAt", o."shopifyCreatedAt") - INTERVAL '30 days' 
          AND e."metaClickId" IS NOT NULL
          AND e."consentState" IN ('GRANTED', 'NOT_REQUIRED')
          AND e."adSharingAllowed" = TRUE
          AND e."eventAt" <= COALESCE(o."processedAt", o."shopifyCreatedAt")
          AND NOT EXISTS (
            SELECT 1 FROM "StorefrontConsentWithdrawal" w
            WHERE w."storeId" = e."storeId" AND e."eventAt" <= w."revokedBefore"
              AND (w."scopeKey" = 'session:' || e."sessionId" OR
                w."scopeKey" = 'visitor:' || e."anonymousVisitorId")
          )
        ORDER BY e."eventAt" DESC, e."receivedAt" DESC
        LIMIT 1
      ) meta_event ON TRUE
      LEFT JOIN LATERAL (
        SELECT COALESCE(e."googleClickId", e."googleBraidedClickId", e."googleWebBraidedClickId") AS "googleClickId", CASE WHEN e."googleClickId" IS NOT NULL THEN 'gclid' WHEN e."googleBraidedClickId" IS NOT NULL THEN 'gbraid' ELSE 'wbraid' END AS "googleClickIdKind", e."eventAt"
        FROM "StorefrontEvent" e
        WHERE e."storeId" = o."storeId"
          AND (e."sessionId" = s."browserSessionId" OR (s."anonymousVisitorId" IS NOT NULL AND e."anonymousVisitorId" = s."anonymousVisitorId"))
          AND e."eventAt" >= conn."installedAt"
          AND e."eventAt" >= COALESCE(o."processedAt", o."shopifyCreatedAt") - INTERVAL '30 days' 
          AND (e."googleClickId" IS NOT NULL OR e."googleBraidedClickId" IS NOT NULL OR e."googleWebBraidedClickId" IS NOT NULL)
          AND e."consentState" IN ('GRANTED', 'NOT_REQUIRED')
          AND e."adSharingAllowed" = TRUE
          AND e."eventAt" <= COALESCE(o."processedAt", o."shopifyCreatedAt")
          AND NOT EXISTS (
            SELECT 1 FROM "StorefrontConsentWithdrawal" w
            WHERE w."storeId" = e."storeId" AND e."eventAt" <= w."revokedBefore"
              AND (w."scopeKey" = 'session:' || e."sessionId" OR
                w."scopeKey" = 'visitor:' || e."anonymousVisitorId")
          )
        ORDER BY e."eventAt" DESC, e."receivedAt" DESC
        LIMIT 1
      ) google_event ON TRUE
      LEFT JOIN LATERAL (
        SELECT e."tiktokClickId", e."eventAt"
        FROM "StorefrontEvent" e
        WHERE e."storeId" = o."storeId"
          AND (e."sessionId" = s."browserSessionId" OR (s."anonymousVisitorId" IS NOT NULL AND e."anonymousVisitorId" = s."anonymousVisitorId"))
          AND e."eventAt" >= conn."installedAt"
          AND e."eventAt" >= COALESCE(o."processedAt", o."shopifyCreatedAt") - INTERVAL '30 days' 
          AND e."tiktokClickId" IS NOT NULL
          AND e."consentState" IN ('GRANTED', 'NOT_REQUIRED')
          AND e."adSharingAllowed" = TRUE
          AND e."eventAt" <= COALESCE(o."processedAt", o."shopifyCreatedAt")
          AND NOT EXISTS (
            SELECT 1 FROM "StorefrontConsentWithdrawal" w
            WHERE w."storeId" = e."storeId" AND e."eventAt" <= w."revokedBefore"
              AND (w."scopeKey" = 'session:' || e."sessionId" OR
                w."scopeKey" = 'visitor:' || e."anonymousVisitorId")
          )
        ORDER BY e."eventAt" DESC, e."receivedAt" DESC
        LIMIT 1
      ) tiktok_event ON TRUE
      WHERE o."isTest" = FALSE
        ${sourceOrderId ? PrismaSql.sql`AND o."id" = ${sourceOrderId}::uuid` : PrismaSql.empty}
        AND (
          SELECT latest."adSharingAllowed" FROM "StorefrontEvent" latest
          WHERE latest."storeId" = o."storeId"
            AND (latest."sessionId" = s."browserSessionId" OR
              (s."anonymousVisitorId" IS NOT NULL AND latest."anonymousVisitorId" = s."anonymousVisitorId"))
          ORDER BY latest."eventAt" DESC, latest."receivedAt" DESC, latest."id" DESC LIMIT 1
        ) = TRUE
        AND o."cancelledAt" IS NULL
        AND COALESCE(o."processedAt", o."shopifyCreatedAt") >= conn."installedAt"
        AND o."currentTotalAmount" IS NOT NULL
        AND COALESCE(o."processedAt", o."shopifyCreatedAt") >= NOW() - INTERVAL '30 days'
        AND (
          meta_event."metaClickId" IS NOT NULL
          OR google_event."googleClickId" IS NOT NULL
          OR tiktok_event."tiktokClickId" IS NOT NULL
          OR identity_event."browserMatchCiphertext" IS NOT NULL
          OR EXISTS (SELECT 1 FROM "ConversionDestination" dest WHERE dest."storeId" = o."storeId" AND dest."status" = 'ACTIVE' AND dest."configJson"->>'enhancedMatching' = 'true')
        )
        ${
          sourceOrderId
            ? PrismaSql.empty
            : PrismaSql.sql`AND EXISTS (
          SELECT 1 FROM "ConversionDestination" dest WHERE dest."storeId" = o."storeId" AND dest."status" = 'ACTIVE'
            AND NOT EXISTS (SELECT 1 FROM "ConversionDelivery" d WHERE d."destinationId" = dest."id" AND d."sourceOrderId" = o."id" AND d."eventName" = 'PURCHASE')
        )`
        }
      ORDER BY o."id", s."endedAt" DESC, s."id" DESC
      LIMIT ${limit}
    `);
  }

  async hasAdvertisingConsent(claim: {
    id?: string;
    sourceOrderId: string | null;
    sourceEventId?: string | null;
    sourceGenerationAt?: Date | null;
    storeId: string;
    provider: AdvertisingProvider;
    clickId: string | null;
    destinationId?: string;
    clickIdKind?: string | null;
    matchingIntent?: boolean;
    eventName?: string;
    match?: unknown;
  }) {
    if (claim.sourceEventId) {
      const source = await prisma.storefrontEvent.findFirst({
        where: { id: claim.sourceEventId, storeId: claim.storeId },
        select: {
          sessionId: true,
          anonymousVisitorId: true,
          eventAt: true,
          adSharingAllowed: true,
          consentState: true,
        },
      });
      if (
        !source ||
        !source.adSharingAllowed ||
        !['GRANTED', 'NOT_REQUIRED'].includes(source.consentState)
      )
        return false;
      const [connection, revoked, latest, order, destination] = await Promise.all([
        prisma.shopifyConnection.findUnique({
          where: { storeId: claim.storeId },
          select: { status: true, installedAt: true, scopes: true },
        }),
        prisma.storefrontConsentWithdrawal.findFirst({
          where: {
            storeId: claim.storeId,
            revokedBefore: { gte: source.eventAt },
            scopeKey: {
              in: [
                source.sessionId ? `session:${source.sessionId}` : '',
                source.anonymousVisitorId ? `visitor:${source.anonymousVisitorId}` : '',
              ].filter(Boolean),
            },
          },
          select: { storeId: true },
        }),
        prisma.storefrontEvent.findFirst({
          where: {
            storeId: claim.storeId,
            OR: [
              ...(source.sessionId ? [{ sessionId: source.sessionId }] : []),
              ...(source.anonymousVisitorId
                ? [{ anonymousVisitorId: source.anonymousVisitorId }]
                : []),
            ],
          },
          orderBy: [{ eventAt: 'desc' }, { receivedAt: 'desc' }, { id: 'desc' }],
          select: { adSharingAllowed: true },
        }),
        claim.sourceOrderId
          ? prisma.order.findFirst({
              where: {
                id: claim.sourceOrderId,
                storeId: claim.storeId,
                isTest: false,
                cancelledAt: null,
              },
              select: { id: true },
            })
          : Promise.resolve(true),
        claim.destinationId
          ? prisma.conversionDestination.findFirst({
              where: {
                id: claim.destinationId,
                storeId: claim.storeId,
                provider: claim.provider,
                status: 'ACTIVE',
              },
              select: { id: true, configJson: true },
            })
          : Promise.resolve(null),
      ]);
      if (!destination && claim.destinationId) return false;
      const config = destination?.configJson as Record<string, unknown> | null;
      if (claim.eventName && claim.eventName !== 'PURCHASE' && config?.funnelEvents !== true)
        return false;
      const match = claim.match as
        { meta?: unknown; tiktok?: unknown; google?: unknown; clientIp?: string } | undefined;
      if ((claim.matchingIntent || match?.meta || match?.tiktok || match?.google || match?.clientIp) && config?.enhancedMatching !== true)
        return false;
      const providerConnection =
        claim.provider === 'META'
          ? await prisma.metaConnection.findUnique({
              where: { storeId: claim.storeId },
              select: { status: true, scopes: true, selectedAdAccountIds: true },
            })
          : claim.provider === 'TIKTOK'
            ? await prisma.tikTokConnection.findUnique({
                where: { storeId: claim.storeId },
                select: { status: true },
              })
            : await prisma.googleAdsConnection.findUnique({
                where: { storeId: claim.storeId },
                select: { status: true, scopes: true, selectedCustomerIds: true },
              });
      if (providerConnection && providerConnection.status !== 'ACTIVE') return false;
      if (
        claim.provider === 'META' &&
        config?.authSource === 'META_CONNECTION' &&
        (!providerConnection ||
          !('scopes' in providerConnection) ||
          !Array.isArray(providerConnection.scopes) ||
          !providerConnection.scopes.includes('ads_management') ||
          !('selectedAdAccountIds' in providerConnection) ||
          !Array.isArray(providerConnection.selectedAdAccountIds) ||
          !providerConnection.selectedAdAccountIds.includes(String(config.adAccountId)))
      )
        return false;
      if (
        claim.provider === 'GOOGLE_ADS' &&
        (!providerConnection ||
          !('scopes' in providerConnection) ||
          !Array.isArray(providerConnection.scopes) ||
          !providerConnection.scopes.includes('https://www.googleapis.com/auth/datamanager') ||
          !('selectedCustomerIds' in providerConnection) ||
          !Array.isArray(providerConnection.selectedCustomerIds) ||
          !providerConnection.selectedCustomerIds.includes(String(config?.customerId)))
      )
        return false;
      if (claim.clickId && claim.sourceOrderId) {
        const candidates = await this.findPurchaseCandidates(1, claim.sourceOrderId);
        if (
          !candidates.some(
            (candidate) =>
              candidate.storeId === claim.storeId &&
              (claim.provider === 'META'
                ? candidate.metaClickId
                : claim.provider === 'TIKTOK'
                  ? candidate.tiktokClickId
                  : candidate.googleClickId) === claim.clickId &&
              (claim.provider !== 'GOOGLE_ADS' || !claim.clickIdKind || candidate.googleClickIdKind === claim.clickIdKind),
          )
        )
          return false;
      }
      return Boolean(
        connection?.status === 'ACTIVE' &&
        connection.scopes.includes('read_customer_events') &&
        claim.sourceGenerationAt &&
        connection.installedAt.getTime() === claim.sourceGenerationAt.getTime() &&
        source.eventAt >= connection.installedAt &&
        !revoked &&
        latest?.adSharingAllowed &&
        order &&
        destination,
      );
    }
    // Existing Purchase records retain their narrower exact-click consent check.
    if (!claim.clickId || !claim.sourceOrderId) return false;
    const candidates = await this.findPurchaseCandidates(1, claim.sourceOrderId);
    return candidates.some(
      (candidate) =>
        candidate.storeId === claim.storeId &&
        (claim.provider === 'META'
          ? candidate.metaClickId
          : claim.provider === 'TIKTOK'
            ? candidate.tiktokClickId
            : candidate.googleClickId) === claim.clickId,
    );
  }

  async discardForConsent(id: string) {
    return prisma.conversionDelivery.update({
      where: { id },
      data: {
        status: 'DEAD',
        processingStartedAt: null,
        reasonCode: 'CONSENT_BLOCKED',
        matchCoverage: PrismaSql.DbNull,
        lastError: 'Advertising consent or source attribution is no longer available',
        clickId: null,
        attributionEventAt: null,
        eventSourceUrl: null,
      },
    });
  }

  async enqueue(input: {
    storeId: string;
    destinationId: string;
    provider: AdvertisingProvider;
    eventKey: string;
    sourceOrderId: string;
    sourceEventId?: string | null;
    sourceGenerationAt?: Date | null;
    shopifyOrderId: string;
    eventAt: Date;
    value: string;
    currencyCode: string;
    clickId: string | null;
    clickIdKind?: string | null;
    attributionEventAt: Date | null;
    eventSourceUrl: string | null;
  }) {
    const result = await prisma.conversionDelivery.createMany({
      data: [{ ...input, eventName: 'PURCHASE' }],
      skipDuplicates: true,
    });
    return { created: result.count > 0 };
  }

  async linkCustomerIdentity(claim: {
    storeId: string;
    sourceOrderId: string | null;
    customerIdentityKey?: string;
    sourceGenerationAt: Date | null;
    sourceEventId?: string | null;
    provider: AdvertisingProvider;
    clickId: string | null;
    destinationId: string;
  }) {
    if (!claim.sourceOrderId || !claim.customerIdentityKey || !claim.sourceGenerationAt) return;
    if (!(await this.hasAdvertisingConsent(claim))) return;
    await prisma.$transaction(async tx => {
      await tx.$queryRaw`SELECT "storeId" FROM "ShopifyConnection" WHERE "storeId" = ${claim.storeId}::uuid FOR UPDATE`;
      await tx.$executeRaw`INSERT INTO "StorefrontCustomerLink" ("sourceOrderId", "storeId", "customerKey", "expiresAt")
        SELECT o."id", o."storeId", ${claim.customerIdentityKey}, NOW() + INTERVAL '90 days'
        FROM "Order" o JOIN "ShopifyConnection" c ON c."storeId" = o."storeId"
        JOIN "StorefrontEvent" e ON e."id" = ${claim.sourceEventId ?? null}::uuid AND e."storeId" = o."storeId"
        JOIN "ConversionDestination" dest ON dest."id" = ${claim.destinationId}::uuid AND dest."storeId" = o."storeId" AND dest."provider"::text = ${claim.provider}
        WHERE o."id" = ${claim.sourceOrderId}::uuid AND o."storeId" = ${claim.storeId}::uuid
          AND c."status" = 'ACTIVE' AND c."installedAt" = ${claim.sourceGenerationAt}
          AND dest."status" = 'ACTIVE' AND dest."configJson"->>'enhancedMatching' = 'true'
          AND e."adSharingAllowed" = TRUE AND e."eventAt" >= c."installedAt"
          AND NOT EXISTS (SELECT 1 FROM "StorefrontConsentWithdrawal" w WHERE w."storeId" = e."storeId" AND w."revokedBefore" >= e."eventAt" AND (w."scopeKey" = 'visitor:' || e."anonymousVisitorId" OR w."scopeKey" = 'session:' || e."sessionId"))
        ON CONFLICT ("sourceOrderId") DO NOTHING`;
    });
  }
  recordCoverage(id: string, coverage: Record<string, boolean>, reasonCode: string | null = null) {
    return prisma.conversionDelivery.update({ where: { id }, data: { matchCoverage: coverage, reasonCode } });
  }
  pauseForConnection(id: string, nextAttemptAt: Date) {
    return prisma.conversionDelivery.update({
      where: { id },
      data: {
        status: 'RETRY',
        processingStartedAt: null,
        nextAttemptAt,
        reasonCode: 'CONNECTION_REAUTH_REQUIRED',
        lastError: 'Reconnect the advertising channel to resume delivery',
      },
    });
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
          AND (sub."status" = 'ACTIVE' OR (sub."provider" = 'INTERNAL' AND sub."trialEndsAt" > ${now}))
          AND (
            (sub."trialEndsAt" > ${now} AND (
              (sub."provider" = 'INTERNAL' AND sub."status" = 'TRIALING')
              OR (sub."provider" = 'SHOPIFY' AND sub."status" = 'ACTIVE')
            ))
            OR sub."selectedPlan" = 'PRO'
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

  markDelivered(id: string, providerRequestId: string | null, deliveredAt: Date, matchingReasonCode: string | null = null) {
    return prisma.conversionDelivery.update({
      where: { id },
      data: {
        status: 'DELIVERED',
        attempts: { increment: 1 },
        processingStartedAt: null,
        deliveredAt,
        providerRequestId,
        lastError: null,
        reasonCode: matchingReasonCode,
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
        ...(status === 'DEAD'
          ? { clickId: null, attributionEventAt: null, eventSourceUrl: null }
          : {}),
        reasonCode: /EVENT_EXPIRED/.test(error) ? 'EVENT_EXPIRED' : /MATCH_ID_MISSING/.test(error)
          ? 'MISSING_MATCH_IDENTIFIER'
          : status === 'DEAD'
            ? 'PROVIDER_REJECTED'
            : 'PROVIDER_RETRY',
      },
    });
  }

  pauseForBilling(id: string, nextAttemptAt: Date) {
    return prisma.conversionDelivery.update({
      where: { id },
      data: {
        status: 'RETRY',
        processingStartedAt: null,
        nextAttemptAt,
        reasonCode: 'ENTITLEMENT_BLOCKED',
        lastError:
          'Delivery paused because the current Stride subscription does not authorize this provider',
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
        sourceOrderId: true,
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
