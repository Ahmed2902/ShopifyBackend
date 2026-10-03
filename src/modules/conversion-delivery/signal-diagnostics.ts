import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { classifyAcquisition } from '../pixel/acquisition.js';

const DAYS = 30;
export async function conversionSignalHealth(storeId: string) {
  const since = new Date(Date.now() - DAYS * 86400_000);
  const [destinations, facts, connections, commercePurchases] = await Promise.all([
    prisma.conversionDestination.findMany({
      where: { storeId },
      select: { id: true, provider: true, displayName: true, status: true, configJson: true },
    }),
    prisma.$queryRaw<
      Array<{
        provider: string;
        eventName: string;
        status: string;
        reasonCode: string | null;
        total: bigint;
        lastDelivery: Date | null;
        clickId: bigint;
        browserId: bigint;
        email: bigint;
        phone: bigint;
        externalId: bigint;
        userAgent: bigint;
        ip: bigint;
    measured: bigint;
      }>
    >(Prisma.sql`
      SELECT "provider", "eventName", "status", "reasonCode", COUNT(*) AS total, MAX("deliveredAt") AS "lastDelivery",
        COUNT(*) FILTER (WHERE "matchCoverage" IS NOT NULL) AS measured,
        COUNT(*) FILTER (WHERE "matchCoverage"->>'clickId' = 'true') AS "clickId",
        COUNT(*) FILTER (WHERE "matchCoverage"->>'browserId' = 'true') AS "browserId",
        COUNT(*) FILTER (WHERE "matchCoverage"->>'email' = 'true') AS email,
        COUNT(*) FILTER (WHERE "matchCoverage"->>'phone' = 'true') AS phone,
        COUNT(*) FILTER (WHERE "matchCoverage"->>'externalId' = 'true') AS "externalId",
        COUNT(*) FILTER (WHERE "matchCoverage"->>'userAgent' = 'true') AS "userAgent",
        COUNT(*) FILTER (WHERE "matchCoverage"->>'ip' = 'true') AS ip
      FROM "ConversionDelivery" WHERE "storeId" = ${storeId}::uuid AND "createdAt" >= ${since}
      GROUP BY "provider", "eventName", "status", "reasonCode"
    `),
    prisma.store.findUnique({
      where: { id: storeId },
      select: {
        metaConnection: { select: { status: true, tokenExpiresAt: true, scopes: true } },
        tiktokConnection: { select: { status: true, accessTokenExpiresAt: true } },
        googleAdsConnection: { select: { status: true, scopes: true } },
      },
    }),
    prisma.order.count({
      where: { storeId, isTest: false, cancelledAt: null, shopifyCreatedAt: { gte: since } },
    }),
  ]);
  return {
    since: since.toISOString(),
    until: new Date().toISOString(),
    methodology:
      'Stride factual delivery-attempt identifier coverage; not provider match rate or Meta Event Match Quality. Purchases are Shopify truth; platform receipt is not proof of attribution.',
    commercePurchases,
    enhancedMatchingApproved: env.SHOPIFY_ENHANCED_MATCHING_APPROVED,
    providers: ['META', 'TIKTOK', 'GOOGLE_ADS'].map((provider) => ({
      provider,
      connection:
        provider === 'META'
          ? {
              status: connections?.metaConnection?.status ?? 'NOT_CONNECTED',
              permissionAvailable:
                connections?.metaConnection?.scopes.includes('ads_management') ?? false,
              tokenExpired: Boolean(
                connections?.metaConnection?.tokenExpiresAt &&
                connections.metaConnection.tokenExpiresAt <= new Date(),
              ),
            }
          : provider === 'TIKTOK'
            ? {
                status: connections?.tiktokConnection?.status ?? 'NOT_CONNECTED',
                tokenExpired: Boolean(
                  connections?.tiktokConnection?.accessTokenExpiresAt &&
                  connections.tiktokConnection.accessTokenExpiresAt <= new Date(),
                ),
                credentialSource: 'EVENTS_MANAGER_DESTINATION',
              }
            : {
                status: connections?.googleAdsConnection?.status ?? 'NOT_CONNECTED',
                permissionAvailable:
                  connections?.googleAdsConnection?.scopes.includes(
                    'https://www.googleapis.com/auth/datamanager',
                  ) ?? false,
              },
      destinations: destinations
        .filter((d) => d.provider === provider)
        .map((d) => ({
          id: d.id,
          name: d.displayName,
          active: d.status === 'ACTIVE',
          enhancedMatching:
            env.SHOPIFY_ENHANCED_MATCHING_APPROVED &&
            (d.configJson as Record<string, unknown> | null)?.enhancedMatching === true,
          funnelEvents: (d.configJson as Record<string, unknown> | null)?.funnelEvents === true,
        })),
      facts: facts
        .filter((f) => f.provider === provider)
        .map((f) => ({
          eventName: f.eventName,
          status: f.status,
          reasonCode: f.reasonCode,
          total: Number(f.total),
          lastDelivery: f.lastDelivery?.toISOString() ?? null,
          coverage: {
            denominator: Number(f.measured),
            clickId: Number(f.clickId),
            browserId: Number(f.browserId),
            email: Number(f.email),
            phone: Number(f.phone),
            externalId: Number(f.externalId),
            userAgent: Number(f.userAgent),
            ip: Number(f.ip),
          },
        })),
    })),
    limitations: [
      'No official Meta EMQ integration',
      'IP is available only from a verified canonical Shopify Purchase with explicit field approval',
      'Native integrations and other tracking apps do not share Stride event IDs',
      'No claim of causal attribution',
    ],
  };
}
export async function acquisitionAnalytics(storeId: string) {
  const since = new Date(Date.now() - DAYS * 86400_000);
  // Bound report work to the latest 10,000 touch facts. Raw evidence makes older classifications
  // rebuildable without silently rewriting the original provider/source semantics.
  const touches = await prisma.storefrontSessionTouch.findMany({
    where: { session: { storeId }, eventAt: { gte: since } },
    orderBy: [{ eventAt: 'desc' }, { id: 'desc' }],
    take: 10001,
  });
  const groups = new Map<
    string,
    {
      channel: string;
      provider: string | null;
      paid: boolean | null;
      touches: number;
      exactAdTouches: number;
      campaigns: Array<{
        campaignId: string;
        adSetId: string | null;
        adId: string | null;
        touches: number;
      }>;
    }
  >();
  for (const touch of touches.slice(0, 10000)) {
    const c = classifyAcquisition(touch);
    const key = JSON.stringify([c.channel, c.provider, c.paid]);
    const g = groups.get(key) ?? {
      channel: c.channel,
      provider: c.provider,
      paid: c.paid,
      touches: 0,
      exactAdTouches: 0,
      campaigns: [],
    };
    g.touches++;
    if (touch.metaResolutionStatus === 'EXACT') {
      g.exactAdTouches++;
      if (touch.metaCampaignExternalId) {
        const campaign = g.campaigns.find(
          (c) =>
            c.campaignId === touch.metaCampaignExternalId &&
            c.adSetId === touch.metaAdSetExternalId &&
            c.adId === touch.metaAdExternalId,
        );
        if (campaign) campaign.touches++;
        else if (g.campaigns.length < 100)
          g.campaigns.push({
            campaignId: touch.metaCampaignExternalId,
            adSetId: touch.metaAdSetExternalId,
            adId: touch.metaAdExternalId,
            touches: 1,
          });
      }
    }
    groups.set(key, g);
  }
  return {
    since: since.toISOString(),
    classificationVersion: 1,
    truncated: touches.length > 10000,
    sampledTouchLimit: 10000,
    items: [...groups.values()],
    methodology:
      'Observed acquisition touches, not unique customers, provider attribution, or causal impact.',
  };
}
