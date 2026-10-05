import { createHash, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { AppError } from '../../errors/app-error.js';
import { billingService } from '../billing/billing.service.js';
import { encryptSecret, decryptSecret } from '../integrations/integration.utils.js';
import { storefrontEventKey } from './funnel.repository.js';
import { metaCustomData, prepareConversionContents } from './conversion-content.js';
import type { ConversionDestinationConfig, DeliveryClaim } from './conversion-delivery.types.js';

export const browserSignalsSchema = z
  .object({
    installationId: z.string().uuid(),
    collectorToken: z.string().regex(/^[A-Za-z0-9_-]{40,128}$/),
    eventIds: z
      .array(z.string().regex(/^[A-Za-z0-9_-]{8,128}$/))
      .min(1)
      .max(20),
    fbp: z
      .string()
      .max(128)
      .regex(/^fb\.[0-2]\.\d{13}\.\d+$/)
      .optional(),
    dispatchedDestinationIds: z.array(z.string().uuid()).max(20).optional(),
    browserFailureCode: z
      .enum([
        'EXISTING_META_BROWSER_TRACKER',
        'META_SDK_UNAVAILABLE',
        'META_SDK_TIMEOUT',
        'BROWSER_CONTEXT_BLOCKED',
      ])
      .optional(),
  })
  .strict();
export const META_BROWSER_NAMES: Record<string, string> = {
  PAGE_VIEW: 'PageView',
  PRODUCT_VIEW: 'ViewContent',
  ADD_TO_CART: 'AddToCart',
};
const pairKey = (eventId: string, destinationId: string) =>
  JSON.stringify([eventId, destinationId]);

// One bounded authorization query for the entire batch. Re-run it after preparation rather
// than caching privacy or account authorization across asynchronous work.
export async function permittedBrowserPairs(
  storeId: string,
  generation: Date,
  eventIds: string[],
  destinationIds: string[],
) {
  if (!eventIds.length || !destinationIds.length) return new Set<string>();
  const rows = await prisma.$queryRaw<
    Array<{ sourceEventId: string; destinationId: string }>
  >(Prisma.sql`
    SELECT e."id" AS "sourceEventId", d."id" AS "destinationId"
    FROM "StorefrontEvent" e
    JOIN "ShopifyConnection" c ON c."storeId" = e."storeId" AND c."status" = 'ACTIVE'
      AND c."installedAt" = ${generation} AND e."eventAt" >= c."installedAt"
      AND 'read_customer_events' = ANY(c.scopes)
    JOIN "PixelInstallation" pi ON pi."storeId" = e."storeId" AND pi.status = 'ACTIVE'
    JOIN "ConversionDestination" d ON d."storeId" = e."storeId" AND d.provider = 'META' AND d.status = 'ACTIVE'
      AND d."configJson"->>'browserEvents' = 'true' AND d."configJson"->>'funnelEvents' = 'true'
      AND d."configJson"->>'overlapPolicy' = 'STRIDE_EXCLUSIVE'
    LEFT JOIN "MetaConnection" mc ON mc."storeId" = e."storeId"
    WHERE e."storeId" = ${storeId}::uuid AND e.id IN (${Prisma.join(eventIds.map((id) => Prisma.sql`${id}::uuid`))})
      AND d.id IN (${Prisma.join(destinationIds.map((id) => Prisma.sql`${id}::uuid`))})
      AND e."eventName" IN ('PAGE_VIEW', 'PRODUCT_VIEW', 'ADD_TO_CART')
      AND e."eventAt" BETWEEN NOW() - INTERVAL '60 seconds' AND NOW() AND e."retentionExpiresAt" > NOW()
      AND e."adSharingAllowed" AND e."consentState" IN ('GRANTED', 'NOT_REQUIRED')
      AND (mc.id IS NULL OR mc.status = 'ACTIVE')
      AND (d."configJson"->>'authSource' IS DISTINCT FROM 'META_CONNECTION' OR
        (mc.id IS NOT NULL AND 'ads_management' = ANY(mc.scopes)
          AND (mc."tokenExpiresAt" IS NULL OR mc."tokenExpiresAt" > NOW())
          AND d."configJson"->>'adAccountId' = ANY(mc."selectedAdAccountIds")))
      AND NOT EXISTS (SELECT 1 FROM "StorefrontConsentWithdrawal" w WHERE w."storeId" = e."storeId"
        AND w."revokedBefore" >= e."eventAt" AND (w."scopeKey" = 'session:' || e."sessionId" OR w."scopeKey" = 'visitor:' || e."anonymousVisitorId"))
      AND (SELECT latest."adSharingAllowed" FROM "StorefrontEvent" latest WHERE latest."storeId" = e."storeId"
        AND (latest."sessionId" = e."sessionId" OR latest."anonymousVisitorId" = e."anonymousVisitorId")
        ORDER BY latest."eventAt" DESC, latest."receivedAt" DESC, latest.id DESC LIMIT 1) = TRUE
  `);
  return new Set(rows.map((r) => pairKey(r.sourceEventId, r.destinationId)));
}

// The public collector credential is ingestion-only. It never authorizes customer-data reads.
export async function authorizeBrowserSignals(input: z.infer<typeof browserSignalsSchema>) {
  const now = new Date();
  const empty = () => ({ dispatches: [], expiresAt: now.toISOString() });
  const installation = await prisma.pixelInstallation.findUnique({
    where: { id: input.installationId },
  });
  const actual = createHash('sha256').update(input.collectorToken).digest();
  const validToken =
    installation &&
    [installation.collectorTokenHash, installation.pendingCollectorTokenHash].some((hash) => {
      if (!hash) return false;
      const expected = Buffer.from(hash, 'hex');
      return expected.length === actual.length && timingSafeEqual(actual, expected);
    });
  if (!installation || installation.status !== 'ACTIVE' || !validToken)
    throw new AppError('Pixel collector credentials are invalid', 401, 'PIXEL_UNAUTHORIZED');
  try {
    await billingService.requireAdProviderReadOnly(installation.storeId, 'META');
  } catch {
    return empty();
  }
  const [events, destinations, connection] = await Promise.all([
    prisma.storefrontEvent.findMany({
      where: {
        storeId: installation.storeId,
        eventId: { in: input.eventIds },
        eventName: { in: ['PAGE_VIEW', 'PRODUCT_VIEW', 'ADD_TO_CART'] },
        adSharingAllowed: true,
        eventAt: { gte: new Date(now.getTime() - 60_000), lte: now },
        receivedAt: { gte: new Date(now.getTime() - 60_000) },
        retentionExpiresAt: { gt: now },
      },
    }),
    prisma.conversionDestination.findMany({
      where: { storeId: installation.storeId, provider: 'META', status: 'ACTIVE' },
    }),
    prisma.shopifyConnection.findUnique({
      where: { storeId: installation.storeId },
      select: { installedAt: true },
    }),
  ]);
  if (!connection) return empty();
  const eligibleDestinations = destinations.filter((d) => {
    const c = d.configJson as ConversionDestinationConfig | null;
    return (
      c?.browserEvents === true &&
      c.funnelEvents === true &&
      c.overlapPolicy === 'STRIDE_EXCLUSIVE' &&
      /^\d+$/.test(d.externalId)
    );
  });
  const check = () =>
    permittedBrowserPairs(
      installation.storeId,
      connection.installedAt,
      events.map((e) => e.id),
      eligibleDestinations.map((d) => d.id),
    );
  const permitted = await check();
  const claims: DeliveryClaim[] = events.flatMap((e) =>
    eligibleDestinations.flatMap((destination) =>
      permitted.has(pairKey(e.id, destination.id))
        ? [
            {
              id: pairKey(e.id, destination.id),
              storeId: e.storeId,
              destinationId: destination.id,
              provider: 'META',
              sourceOrderId: null,
              sourceEventId: e.id,
              sourceGenerationAt: connection.installedAt,
              eventKey: storefrontEventKey(e.storeId, e.eventId),
              eventName: e.eventName,
              eventAt: e.eventAt,
              attributionEventAt: e.eventAt,
              clickId: e.metaClickId,
              eventSourceUrl: e.pageUrl,
              value: null,
              currencyCode: null,
              shopifyOrderId: null,
              destination,
            } as DeliveryClaim,
          ]
        : [],
    ),
  );
  if (!claims.length) return empty();
  if (input.fbp) {
    const sourceIds = new Set(claims.map((c) => c.sourceEventId));
    const updates = events
      .filter((e) => sourceIds.has(e.id))
      .map((e) => {
        let retained: Record<string, unknown> = {};
        if (e.browserMatchCiphertext && e.browserMatchExpiresAt && e.browserMatchExpiresAt > now) {
          try {
            retained = JSON.parse(decryptSecret(e.browserMatchCiphertext));
          } catch {
            /* Never log payloads. */
          }
        }
        return Prisma.sql`(${e.id}::uuid, ${encryptSecret(JSON.stringify({ ...retained, fbp: input.fbp }))}, ${new Date(Math.min(e.retentionExpiresAt.getTime(), e.eventAt.getTime() + 48 * 3600_000))}::timestamp)`;
      });
    const issuedAt = new Date(Number(input.fbp.split('.')[2]));
    if (Number.isFinite(issuedAt.getTime()) && issuedAt <= now)
      await prisma.$executeRaw(Prisma.sql`
      UPDATE "StorefrontEvent" e SET "browserMatchCiphertext" = v.cipher, "browserMatchExpiresAt" = v.expires
      FROM (VALUES ${Prisma.join(updates)}) v(id, cipher, expires)
      WHERE e.id = v.id AND e."storeId" = ${installation.storeId}::uuid AND e."adSharingAllowed"
        AND NOT EXISTS (SELECT 1 FROM "StorefrontConsentWithdrawal" w WHERE w."storeId" = e."storeId"
          AND w."revokedBefore" >= ${issuedAt} AND (w."scopeKey" = 'session:' || e."sessionId" OR w."scopeKey" = 'visitor:' || e."anonymousVisitorId"))
    `);
  }
  await prisma.conversionDelivery.createMany({
    data: claims.map((c) => ({
      storeId: c.storeId,
      destinationId: c.destinationId,
      provider: 'META' as const,
      sourceEventId: c.sourceEventId,
      sourceGenerationAt: c.sourceGenerationAt,
      eventKey: c.eventKey,
      eventName: c.eventName,
      eventAt: c.eventAt,
      eventSourceUrl: c.eventSourceUrl,
      clickId: c.clickId,
      attributionEventAt: c.attributionEventAt,
      nextAttemptAt: new Date(now.getTime() + 15_000),
    })),
    skipDuplicates: true,
  });
  const deliveries = await prisma.conversionDelivery.findMany({
    where: {
      storeId: installation.storeId,
      OR: claims.map((c) => ({ destinationId: c.destinationId, eventKey: c.eventKey })),
      status: { notIn: ['DEAD', 'SKIPPED'] },
    },
  });
  const retainedClaims = claims.flatMap((c) => {
    const delivery = deliveries.find(
      (d) => d.destinationId === c.destinationId && d.eventKey === c.eventKey,
    );
    return delivery ? [Object.assign(c, delivery)] : [];
  });
  if (input.dispatchedDestinationIds || input.browserFailureCode) {
    const current = await check();
    const reported = retainedClaims.filter(
      (c) =>
        (input.browserFailureCode || input.dispatchedDestinationIds!.includes(c.destinationId)) &&
        current.has(pairKey(c.sourceEventId!, c.destinationId)),
    );
    try {
      await billingService.requireAdProviderReadOnly(installation.storeId, 'META');
    } catch {
      return empty();
    }
    if (reported.length)
      await prisma.conversionDelivery.updateMany({
        where: {
          storeId: installation.storeId,
          id: { in: reported.map((c) => c.id) },
          browserDispatchedAt: null,
        },
        data: input.browserFailureCode
          ? { browserReasonCode: input.browserFailureCode }
          : { browserDispatchedAt: now, browserReasonCode: null },
      });
    return empty(); // SDK invocation report; never call this provider receipt.
  }
  await prepareConversionContents(retainedClaims);
  const current = await check();
  try {
    await billingService.requireAdProviderReadOnly(installation.storeId, 'META');
  } catch {
    return empty();
  }
  return {
    dispatches: retainedClaims
      .filter(
        (c) => !c.browserDispatchedAt && current.has(pairKey(c.sourceEventId!, c.destinationId)),
      )
      .map((c) => ({
        destinationId: c.destinationId,
        clientEventId: events.find((e) => e.id === c.sourceEventId)!.eventId,
        pixelId: c.destination.externalId,
        eventName: META_BROWSER_NAMES[c.eventName]!,
        eventId: c.eventKey,
        customData: metaCustomData(c),
      })),
    expiresAt: new Date(Date.now() + 5000).toISOString(),
  };
}
