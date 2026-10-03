import { createHash } from 'node:crypto';
import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { billingService } from '../billing/billing.service.js';

export function storefrontEventKey(storeId: string, eventId: string) {
  return `stride:event:${createHash('sha256')
    .update(JSON.stringify([storeId, eventId]))
    .digest('hex')}`;
}
export async function enqueueFunnelEvents(limit = 200) {
  const candidates = await prisma.$queryRaw<
    Array<{
      id: string;
      storeId: string;
      destinationId: string;
      provider: 'META' | 'TIKTOK';
      generation: Date;
    }>
  >(Prisma.sql`
    SELECT e."id", e."storeId", dest."id" AS "destinationId", dest."provider", conn."installedAt" AS "generation"
    FROM "StorefrontEvent" e
    JOIN "ShopifyConnection" conn ON conn."storeId" = e."storeId" AND conn."status" = 'ACTIVE'
    JOIN "ConversionDestination" dest ON dest."storeId" = e."storeId" AND dest."status" = 'ACTIVE'
      AND dest."provider" IN ('META', 'TIKTOK') AND dest."configJson"->>'funnelEvents' = 'true'
    WHERE (dest."provider" <> 'TIKTOK' OR e."eventName" <> 'PAGE_VIEW')
      AND e."eventName" IN ('PAGE_VIEW', 'PRODUCT_VIEW', 'ADD_TO_CART', 'BEGIN_CHECKOUT')
      AND e."adSharingAllowed" = TRUE AND e."consentState" IN ('GRANTED', 'NOT_REQUIRED')
      AND e."eventAt" >= conn."installedAt" AND e."eventAt" >= NOW() - INTERVAL '48 hours'
      AND e."retentionExpiresAt" > NOW()
      AND (e."metaClickId" IS NOT NULL OR e."tiktokClickId" IS NOT NULL OR e."browserMatchCiphertext" IS NOT NULL)
      AND NOT EXISTS (SELECT 1 FROM "StorefrontConsentWithdrawal" w WHERE w."storeId" = e."storeId" AND w."revokedBefore" >= e."eventAt" AND (w."scopeKey" = 'session:' || e."sessionId" OR w."scopeKey" = 'visitor:' || e."anonymousVisitorId"))
      AND NOT EXISTS (SELECT 1 FROM "ConversionDelivery" d WHERE d."destinationId" = dest."id" AND d."sourceEventId" = e."id")
    ORDER BY e."receivedAt", e."id", dest."id" LIMIT ${Math.min(Math.max(Math.trunc(limit), 1), 1000)}
  `);
  const events = await prisma.storefrontEvent.findMany({
    where: { id: { in: candidates.map((c) => c.id) }, adSharingAllowed: true },
  });
  const byId = new Map(events.map((e) => [e.id, e]));
  const permitted = new Map<string, boolean>();
  let enqueued = 0;
  for (const candidate of candidates) {
    const key = `${candidate.storeId}:${candidate.provider}`;
    if (!permitted.has(key)) {
      try {
        await billingService.requireAdProviderReadOnly(candidate.storeId, candidate.provider);
        permitted.set(key, true);
      } catch {
        permitted.set(key, false);
      }
    }
    if (!permitted.get(key)) continue;
    const event = byId.get(candidate.id);
    if (!event) continue;
    const result = await prisma.conversionDelivery.createMany({
      data: [
        {
          storeId: event.storeId,
          destinationId: candidate.destinationId,
          provider: candidate.provider,
          eventKey: storefrontEventKey(event.storeId, event.eventId),
          eventName: event.eventName,
          sourceEventId: event.id,
          sourceGenerationAt: candidate.generation,
          eventAt: event.eventAt,
          clickId: candidate.provider === 'META' ? event.metaClickId : event.tiktokClickId,
          attributionEventAt: event.eventAt,
          eventSourceUrl: event.pageUrl,
        },
      ],
      skipDuplicates: true,
    });
    enqueued += result.count;
  }
  return { candidates: candidates.length, enqueued };
}
