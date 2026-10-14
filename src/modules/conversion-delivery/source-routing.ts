import { Prisma, type AdvertisingProvider } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { classifyAcquisition, type AcquisitionEvidence } from '../pixel/acquisition.js';

export const ROUTING_WINDOW_DAYS = 30;
export const ROUTING_POLICY = 'OBSERVED_PAID_TOUCHES_V1';
export type RoutingInput = {
  storeId: string;
  sourceEventId: string;
  eventAt: Date;
  sourceGenerationAt: Date;
  journeyTouches?: RoutingTouch[];
};
export type RoutingTouch = AcquisitionEvidence & {
  eventAt: Date | string;
  utmContent?: string | null;
};
export type PaidTouch = {
  provider: AdvertisingProvider;
  observedAt: string;
  basis: string;
  campaign: string | null;
  ad: string | null;
};
export type RoutingSummary = {
  policy: typeof ROUTING_POLICY;
  windowDays: number;
  eligibleProviders: AdvertisingProvider[];
  touches: PaidTouch[];
  lastPaidTouch: PaidTouch | null;
  reason: 'PAID_TOUCH_FOUND' | 'NO_PAID_TOUCH' | 'AMBIGUOUS_TOUCH' | 'EVIDENCE_LIMIT_REACHED';
  ambiguousTouches: number;
};
const paidMedia = new Set([
  'paid_social',
  'paidsocial',
  'social_paid',
  'paid_search',
  'sem',
  'ppc',
  'cpc',
]);
// Source classification is not the same as verified ad-platform attribution. In particular,
// fbclid may decorate organic Meta links, and browser matching cookies are not paid touches.
export function summarizeRouting(
  rows: RoutingTouch[],
  eventAt: Date,
  generation: Date,
): RoutingSummary {
  const lower = Math.max(generation.getTime(), eventAt.getTime() - ROUTING_WINDOW_DAYS * 86400_000);
  const dedup = new Map<string, PaidTouch>();
  let ambiguousTouches = 0;
  for (const row of rows.slice(0, 1000)) {
    const time = new Date(row.eventAt).getTime();
    if (!Number.isFinite(time) || time < lower || time > eventAt.getTime()) continue;
    const clickProviders = [
      row.metaClickId ? 'META' : null,
      row.tiktokClickId ? 'TIKTOK' : null,
      row.googleClickId || row.googleBraidedClickId || row.googleWebBraidedClickId
        ? 'GOOGLE_ADS'
        : null,
    ].filter(Boolean);
    const linkProviders = [row.metaAdExternalId || row.metaAdSetExternalId || row.metaCampaignExternalId ? 'META' : null,
      row.tiktokCampaignExternalId || row.tiktokAdGroupExternalId || row.tiktokAdExternalId || row.tiktokCreativeExternalId ? 'TIKTOK' : null].filter(Boolean);
    const signalProviders = [...new Set([...clickProviders, ...linkProviders])];
    const c = classifyAcquisition(row);
    const declared = classifyAcquisition({
      utmSource: row.utmSource,
      utmMedium: row.utmMedium,
      utmCampaign: row.utmCampaign,
    });
    const canonical = (p: string | null): AdvertisingProvider | null =>
      p === 'META' || p === 'INSTAGRAM'
        ? 'META'
        : p === 'TIKTOK'
          ? 'TIKTOK'
          : p === 'GOOGLE'
            ? 'GOOGLE_ADS'
            : null;
    const provider = canonical(c.provider);
    const declaredProvider = canonical(declared.provider);
    if (
      signalProviders.length > 1 ||
      (signalProviders.length && declaredProvider && declaredProvider !== provider)
    ) {
      ambiguousTouches++;
      continue;
    }
    if (!provider || c.paid !== true) continue;
    if (
      provider === 'META' &&
      !paidMedia.has(row.utmMedium?.trim().toLowerCase() ?? '') &&
      !row.metaAdExternalId &&
      !row.metaAdSetExternalId &&
      !row.metaCampaignExternalId
    )
      continue;
    // Explicit organic/email labels conflict with purported paid-click evidence.
    if (signalProviders.length && declared.paid === false) {
      ambiguousTouches++;
      continue;
    }
    const click =
      provider === 'META'
        ? row.metaClickId
        : provider === 'TIKTOK'
          ? row.tiktokClickId
          : row.googleClickId || row.googleBraidedClickId || row.googleWebBraidedClickId;
    const key = click
      ? JSON.stringify([provider, click])
      : JSON.stringify([
          provider,
          row.utmSource,
          row.utmMedium,
          row.utmCampaign,
          row.utmContent,
          row.metaAdExternalId,
          row.metaCampaignExternalId,
          row.tiktokCampaignExternalId,
          row.tiktokAdGroupExternalId,
          row.tiktokAdExternalId,
          row.tiktokCreativeExternalId,

        ]);
    const touch: PaidTouch = {
      provider,
      observedAt: new Date(time).toISOString(),
      basis: c.basis,
      campaign: (provider === 'TIKTOK' ? row.tiktokCampaignExternalId : row.metaCampaignExternalId) ?? row.utmCampaign ?? null,
      ad: provider === 'TIKTOK' ? row.tiktokAdExternalId ?? null : row.metaAdExternalId ?? row.utmContent ?? null,
    };
    const prior = dedup.get(key);
    // Repeated landing context is one observed touch, not a new ad click on every page.
    if (!prior || touch.observedAt < prior.observedAt) dedup.set(key, touch);
  }
  const touches = [...dedup.values()].sort((a, b) => a.observedAt.localeCompare(b.observedAt));
  const overLimit = rows.length > 1000;
  // Conservative ambiguity handling: don't assign a journey containing conflicting evidence.
  const eligible =
    !overLimit && ambiguousTouches === 0 ? [...new Set(touches.map((t) => t.provider))] : [];
  return {
    policy: ROUTING_POLICY,
    windowDays: ROUTING_WINDOW_DAYS,
    eligibleProviders: eligible,
    touches: overLimit ? [] : touches,
    lastPaidTouch: !overLimit && !ambiguousTouches ? (touches.at(-1) ?? null) : null,
    reason: overLimit
      ? 'EVIDENCE_LIMIT_REACHED'
      : ambiguousTouches
        ? 'AMBIGUOUS_TOUCH'
        : eligible.length
          ? 'PAID_TOUCH_FOUND'
          : 'NO_PAID_TOUCH',
    ambiguousTouches,
  };
}

export function routingKey(input: RoutingInput) {
  return JSON.stringify([
    input.storeId,
    input.sourceEventId,
    input.eventAt.toISOString(),
    input.sourceGenerationAt.toISOString(),
  ]);
}
// Batch purchase candidates in one query. Scope, generation, retention, consent and withdrawals
// apply to every touch, not just the checkout observation. No customer data or secrets are read.
export async function loadRoutingSummaries(inputs: RoutingInput[]) {
  const result = new Map<string, RoutingSummary>();
  if (!inputs.length) return result;
  const unique = [...new Map(inputs.map((x) => [routingKey(x), x])).values()];
  const payload = unique.map((x) => ({
    key: routingKey(x),
    storeId: x.storeId,
    sourceEventId: x.sourceEventId,
    eventAt: x.eventAt.toISOString(),
    generation: x.sourceGenerationAt.toISOString(),
  }));
  const rows = await prisma.$queryRaw<Array<{ key: string; touches: RoutingTouch[]; revokedBefore: Date | null }>>(Prisma.sql`
    SELECT i.key, (SELECT MAX(w."revokedBefore") FROM "StorefrontConsentWithdrawal" w WHERE w."storeId" = source."storeId" AND (w."scopeKey" = 'session:' || source."sessionId" OR w."scopeKey" = 'visitor:' || source."anonymousVisitorId")) AS "revokedBefore", COALESCE(jsonb_agg(to_jsonb(t) - 'receivedAt' ORDER BY t."eventAt", t."receivedAt") FILTER (WHERE t."eventAt" IS NOT NULL), '[]'::jsonb) AS touches
    FROM jsonb_to_recordset(${JSON.stringify(payload)}::jsonb) AS i(key text, "storeId" uuid, "sourceEventId" uuid, "eventAt" timestamptz, generation timestamptz)
    JOIN "StorefrontEvent" source ON source.id = i."sourceEventId" AND source."storeId" = i."storeId"
    LEFT JOIN LATERAL (
      SELECT MIN(e."eventAt") AS "eventAt", MIN(e."receivedAt") AS "receivedAt", e."metaClickId", e."tiktokClickId", e."googleClickId", e."googleBraidedClickId", e."googleWebBraidedClickId",
        e."utmSource", e."utmMedium", e."utmCampaign", e."utmContent", e."metaCampaignExternalId", e."metaAdSetExternalId", e."metaAdExternalId", e."tiktokCampaignExternalId", e."tiktokAdGroupExternalId", e."tiktokAdExternalId", e."tiktokCreativeExternalId"
      FROM "StorefrontEvent" e
      WHERE e."storeId" = i."storeId"
        AND (e.id = source.id OR e."sessionId" = source."sessionId" OR (source."anonymousVisitorId" IS NOT NULL AND e."anonymousVisitorId" = source."anonymousVisitorId"))
        AND e."eventAt" >= i.generation AND e."eventAt" <= i."eventAt"
        AND e."retentionExpiresAt" > NOW() AND e."adSharingAllowed" = TRUE AND e."consentState" IN ('GRANTED', 'NOT_REQUIRED')
        AND (e."utmSource" IS NOT NULL OR e."metaClickId" IS NOT NULL OR e."tiktokClickId" IS NOT NULL OR e."googleClickId" IS NOT NULL OR e."googleBraidedClickId" IS NOT NULL OR e."googleWebBraidedClickId" IS NOT NULL OR e."metaAdExternalId" IS NOT NULL OR e."metaCampaignExternalId" IS NOT NULL OR e."tiktokCampaignExternalId" IS NOT NULL OR e."tiktokAdGroupExternalId" IS NOT NULL OR e."tiktokAdExternalId" IS NOT NULL OR e."tiktokCreativeExternalId" IS NOT NULL )
        AND NOT EXISTS (SELECT 1 FROM "StorefrontConsentWithdrawal" w WHERE w."storeId" = e."storeId" AND w."revokedBefore" >= e."eventAt" AND (w."scopeKey" = 'session:' || e."sessionId" OR w."scopeKey" = 'visitor:' || e."anonymousVisitorId"))
      GROUP BY e."metaClickId", e."tiktokClickId", e."googleClickId", e."googleBraidedClickId", e."googleWebBraidedClickId", e."utmSource", e."utmMedium", e."utmCampaign", e."utmContent", e."metaCampaignExternalId", e."metaAdSetExternalId", e."metaAdExternalId", e."tiktokCampaignExternalId", e."tiktokAdGroupExternalId", e."tiktokAdExternalId", e."tiktokCreativeExternalId"
      HAVING MIN(e."eventAt") >= GREATEST(i.generation, i."eventAt" - INTERVAL '30 days')
      ORDER BY MIN(e."eventAt"), MIN(e."receivedAt") LIMIT 1001
    ) t ON TRUE GROUP BY i.key, source."storeId", source."sessionId", source."anonymousVisitorId"`);
  const byKey = new Map(rows.map((r) => [r.key, r.touches]));
  const revoked = new Map(rows.map(r => [r.key, r.revokedBefore]));
  for (const input of unique)
    result.set(
      routingKey(input),
      summarizeRouting([...(byKey.get(routingKey(input)) ?? []), ...(input.journeyTouches ?? []).filter(t => !revoked.get(routingKey(input)) || new Date(t.eventAt) > new Date(revoked.get(routingKey(input))!))], input.eventAt, input.sourceGenerationAt),
    );
  return result;
}
