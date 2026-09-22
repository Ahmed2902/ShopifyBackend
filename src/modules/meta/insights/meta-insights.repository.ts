import { createHash } from 'node:crypto';
import { Prisma, type MetaInsightActionKind } from '../../../generated/prisma/client.js';
import { AppError } from '../../../errors/app-error.js';
import { prisma } from '../../../lib/prisma.js';
import { advertisingWriteRepository } from '../../advertising/advertising-write.repository.js';
import type { MetaInsightActionRow, MetaInsightRow } from './meta-insights.schema.js';

function stableHash(parts: Array<string | null | undefined>): string {
  return createHash('sha256').update(parts.map((part) => part ?? '').join('\u001f')).digest('hex');
}

function decimalMetric(value: string | number | null | undefined): string | null {
  if (value === null || value === undefined || value === '') return null;
  const raw = String(value);
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(raw)) {
    throw new AppError('Meta returned an invalid numeric insight metric', 502, 'META_BAD_RESPONSE');
  }
  return raw;
}

function bigintMetric(value: string | number | null | undefined): bigint {
  if (value === null || value === undefined || value === '') return 0n;
  const raw = String(value);
  if (!/^\d+$/.test(raw)) {
    throw new AppError('Meta returned an invalid integer insight metric', 502, 'META_BAD_RESPONSE');
  }
  return BigInt(raw);
}

function sumActionValues(rows: MetaInsightActionRow[]): bigint {
  let total = 0n;
  for (const row of rows) {
    const raw = String(row.value);
    if (!/^\d+(?:\.0+)?$/.test(raw)) continue;
    total += BigInt(raw.split('.')[0]!);
  }
  return total;
}

const PURCHASE_ACTION_PRIORITY = [
  'offsite_conversion.fb_pixel_purchase',
  'omni_purchase',
  'purchase',
] as const;

function purchaseRank(actionType: string): number {
  const exact = PURCHASE_ACTION_PRIORITY.indexOf(
    actionType as (typeof PURCHASE_ACTION_PRIORITY)[number],
  );
  if (exact >= 0) return exact;
  return actionType.toLowerCase().includes('purchase') ? PURCHASE_ACTION_PRIORITY.length : 100;
}

function selectedPurchaseMetric(rows: MetaInsightActionRow[]): number {
  const candidates = rows.filter((row) => purchaseRank(row.action_type) < 100);
  if (candidates.length === 0) return 0;
  const bestRank = Math.min(...candidates.map((row) => purchaseRank(row.action_type)));
  const selectedType = candidates.find((row) => purchaseRank(row.action_type) === bestRank)?.action_type;
  if (!selectedType) return 0;
  return candidates
    .filter((row) => row.action_type === selectedType)
    .reduce((sum, row) => sum + Number(decimalMetric(row.value) ?? 0), 0);
}

function selectedPurchaseRoas(row: MetaInsightRow): number | null {
  for (const rows of [row.website_purchase_roas, row.purchase_roas]) {
    const candidates = rows.filter((item) => purchaseRank(item.action_type) < 100);
    if (candidates.length === 0) continue;
    const bestRank = Math.min(...candidates.map((item) => purchaseRank(item.action_type)));
    const selectedType = candidates.find((item) => purchaseRank(item.action_type) === bestRank)?.action_type;
    if (!selectedType) continue;
    const values = candidates
      .filter((item) => item.action_type === selectedType)
      .map((item) => Number(decimalMetric(item.value) ?? 0))
      .filter((value) => value > 0);
    if (values.length > 0) return Math.max(...values);
  }
  return null;
}

const actionCollections: Array<{
  key: keyof Pick<
    MetaInsightRow,
    | 'actions'
    | 'unique_actions'
    | 'action_values'
    | 'cost_per_action_type'
    | 'cost_per_unique_action_type'
    | 'conversions'
    | 'conversion_values'
    | 'purchase_roas'
    | 'website_purchase_roas'
  >;
  kind: MetaInsightActionKind;
}> = [
  { key: 'actions', kind: 'ACTION' },
  { key: 'unique_actions', kind: 'UNIQUE_ACTION' },
  { key: 'action_values', kind: 'ACTION_VALUE' },
  { key: 'cost_per_action_type', kind: 'COST_PER_ACTION' },
  { key: 'cost_per_unique_action_type', kind: 'COST_PER_UNIQUE_ACTION' },
  { key: 'conversions', kind: 'CONVERSION' },
  { key: 'conversion_values', kind: 'CONVERSION_VALUE' },
  { key: 'purchase_roas', kind: 'PURCHASE_ROAS' },
  { key: 'website_purchase_roas', kind: 'WEBSITE_PURCHASE_ROAS' },
];

export class MetaInsightsRepository {
  findAccount(storeId: string, connectionId: string, metaAccountId: string) {
    return prisma.metaAdAccount.findFirst({
      where: { storeId, metaConnectionId: connectionId, metaAccountId },
      select: {
        id: true,
        metaAccountId: true,
        currency: true,
        timezoneName: true,
      },
    });
  }

  async getHierarchyMaps(adAccountId: string) {
    const [campaigns, adSets, ads] = await Promise.all([
      prisma.metaCampaign.findMany({
        where: { adAccountId },
        select: { id: true, metaCampaignId: true },
      }),
      prisma.metaAdSet.findMany({
        where: { adAccountId },
        select: { id: true, metaAdSetId: true },
      }),
      prisma.metaAd.findMany({
        where: { adAccountId },
        select: {
          id: true,
          metaAdId: true,
          creativeId: true,
          metaUpdatedAt: true,
          deletedAt: true,
        },
      }),
    ]);
    return {
      campaigns: new Map(campaigns.map((item) => [item.metaCampaignId, item.id])),
      adSets: new Map(adSets.map((item) => [item.metaAdSetId, item.id])),
      // Keep soft-deleted ads addressable for historical local-ID mapping, but never use their
      // stale creative assignment as proof for immutable creative snapshot finalization.
      ads: new Map(ads.map((item) => [item.metaAdId, item.id])),
      adCreatives: new Map(
        ads
          .filter((item) => item.deletedAt === null)
          .map((item) => [
            item.metaAdId,
            { creativeId: item.creativeId, metaUpdatedAt: item.metaUpdatedAt },
          ]),
      ),
    };
  }

  hasInsights(adAccountId: string) {
    return prisma.metaInsightDaily
      .findFirst({ where: { adAccountId, level: 'AD' }, select: { id: true } })
      .then(Boolean);
  }

  async upsertDailyInsight(input: {
    adAccountId: string;
    campaignId: string | null;
    adSetId: string | null;
    adId: string | null;
    creativeIdSnapshot: string | null;
    trackCreativeSnapshot: boolean;
    row: MetaInsightRow;
    actionReportTime: string;
  }): Promise<string> {
    const insightKey = stableHash([
      input.adAccountId,
      'AD',
      input.row.date_start,
      input.row.campaign_id,
      input.row.adset_id,
      input.row.ad_id,
    ]);
    const date = new Date(`${input.row.date_start}T00:00:00.000Z`);
    const rawJson = input.row as unknown as Prisma.InputJsonValue;
    const videoMetrics = {
      thruplay: input.row.video_thruplay_watched_actions ?? null,
      avgTime: input.row.video_avg_time_watched_actions ?? null,
      p25: input.row.video_p25_watched_actions ?? null,
      p50: input.row.video_p50_watched_actions ?? null,
      p75: input.row.video_p75_watched_actions ?? null,
      p95: input.row.video_p95_watched_actions ?? null,
      p100: input.row.video_p100_watched_actions ?? null,
      sec30: input.row.video_30_sec_watched_actions ?? null,
      plays: input.row.video_play_actions ?? null,
    } as Prisma.InputJsonValue;
    const mutableData = {
      campaignId: input.campaignId,
      adSetId: input.adSetId,
      adId: input.adId,
      accountCurrency: input.row.account_currency,
      spend: decimalMetric(input.row.spend) ?? '0',
      socialSpend: decimalMetric(input.row.social_spend),
      impressions: bigintMetric(input.row.impressions),
      reach: bigintMetric(input.row.reach),
      clicks: bigintMetric(input.row.clicks),
      uniqueClicks: bigintMetric(input.row.unique_clicks),
      outboundClicks: sumActionValues(input.row.outbound_clicks),
      uniqueOutboundClicks: sumActionValues(input.row.unique_outbound_clicks),
      inlineLinkClicks: bigintMetric(input.row.inline_link_clicks),
      inlinePostEngagement: bigintMetric(input.row.inline_post_engagement),
      estimatedAdRecallers:
        input.row.estimated_ad_recallers == null
          ? null
          : bigintMetric(input.row.estimated_ad_recallers),
      estimatedAdRecallRate: decimalMetric(input.row.estimated_ad_recall_rate),
      cpc: decimalMetric(input.row.cpc),
      cpm: decimalMetric(input.row.cpm),
      cpp: decimalMetric(input.row.cpp),
      ctr: decimalMetric(input.row.ctr),
      frequency: decimalMetric(input.row.frequency),
      objective: input.row.objective ?? null,
      optimizationGoal: input.row.optimization_goal ?? null,
      attributionSetting: input.row.attribution_setting ?? null,
      actionReportTime: input.actionReportTime,
      websiteCtr: (input.row.website_ctr ?? Prisma.DbNull) as Prisma.InputJsonValue,
      conversions: (input.row.conversions ?? []) as unknown as Prisma.InputJsonValue,
      conversionValues: (input.row.conversion_values ?? []) as unknown as Prisma.InputJsonValue,
      videoMetrics,
      rawJson,
      syncedAt: new Date(),
    };

    const purchases = selectedPurchaseMetric(input.row.actions);
    const directPurchaseValue = selectedPurchaseMetric(input.row.action_values);
    const fallbackRoas = selectedPurchaseRoas(input.row);
    const spend = Number(mutableData.spend);
    const purchaseValue = directPurchaseValue > 0 ? directPurchaseValue : spend * (fallbackRoas ?? 0);

    return prisma.$transaction(async (tx) => {
      const insight = await tx.metaInsightDaily.upsert({
        where: { insightKey },
        create: {
          insightKey,
          adAccountId: input.adAccountId,
          creativeIdSnapshot: input.trackCreativeSnapshot ? input.creativeIdSnapshot : null,
          creativeSnapshotTracked: input.trackCreativeSnapshot,
          level: 'AD',
          date,
          ...mutableData,
        },
        // Existing snapshot/tracking provenance is never rewritten here. A null snapshot may only
        // be finalized below when this row was explicitly enrolled in tracking on its reporting day.
        update: mutableData,
        select: { id: true, creativeIdSnapshot: true },
      });

      if (input.creativeIdSnapshot) {
        await tx.metaInsightDaily.updateMany({
          where: {
            id: insight.id,
            creativeSnapshotTracked: true,
            creativeIdSnapshot: null,
          },
          data: { creativeIdSnapshot: input.creativeIdSnapshot },
        });
      }

      await tx.metaInsightAction.deleteMany({ where: { insightId: insight.id } });
      const actions: Prisma.MetaInsightActionCreateManyInput[] = [];
      for (const collection of actionCollections) {
        for (const action of input.row[collection.key]) {
          const value = decimalMetric(action.value);
          if (value === null) continue;
          actions.push({
            actionKey: stableHash([
              insightKey,
              collection.kind,
              action.action_type,
              action.action_destination ?? null,
            ]),
            insightId: insight.id,
            kind: collection.kind,
            actionType: action.action_type,
            actionDestination: action.action_destination ?? null,
            value,
            attributionWindow: null,
            metadata: action as unknown as Prisma.InputJsonValue,
          });
        }
      }
      if (actions.length > 0) await tx.metaInsightAction.createMany({ data: actions });

      const canonicalCreativeId = input.creativeIdSnapshot ?? insight.creativeIdSnapshot;
      await advertisingWriteRepository.upsertDailyMetric(tx, {
        id: insight.id,
        metricKey: `META:${insightKey}`,
        accountId: input.adAccountId,
        campaignId: input.campaignId,
        groupId: input.adSetId,
        adId: input.adId,
        creativeIdSnapshot: canonicalCreativeId,
        level: 'AD',
        date,
        currency: input.row.account_currency,
        spend: mutableData.spend,
        impressions: mutableData.impressions,
        reach: mutableData.reach,
        clicks: mutableData.clicks,
        conversions: purchases,
        conversionValue: purchaseValue,
        ctr: mutableData.ctr,
        cpc: mutableData.cpc,
        cpm: mutableData.cpm,
        frequency: mutableData.frequency,
        cpa: purchases > 0 ? spend / purchases : null,
        roas: spend > 0 ? purchaseValue / spend : fallbackRoas,
        providerMetrics: {
          socialSpend: mutableData.socialSpend,
          uniqueClicks: mutableData.uniqueClicks,
          outboundClicks: mutableData.outboundClicks,
          uniqueOutboundClicks: mutableData.uniqueOutboundClicks,
          inlineLinkClicks: mutableData.inlineLinkClicks,
          inlinePostEngagement: mutableData.inlinePostEngagement,
          estimatedAdRecallers: mutableData.estimatedAdRecallers,
          estimatedAdRecallRate: mutableData.estimatedAdRecallRate,
          cpp: mutableData.cpp,
          objective: mutableData.objective,
          optimizationGoal: mutableData.optimizationGoal,
          attributionSetting: mutableData.attributionSetting,
          actionReportTime: mutableData.actionReportTime,
          websiteCtr: input.row.website_ctr,
          actions: input.row.actions,
          uniqueActions: input.row.unique_actions,
          actionValues: input.row.action_values,
          conversions: input.row.conversions,
          conversionValues: input.row.conversion_values,
          purchaseRoas: input.row.purchase_roas,
          websitePurchaseRoas: input.row.website_purchase_roas,
          videoMetrics,
        },
        rawJson: input.row,
        syncedAt: mutableData.syncedAt,
      });
      return insightKey;
    });
  }

  deleteMissingRange(adAccountId: string, since: Date, until: Date, insightKeys: string[]) {
    const canonicalKeys = insightKeys.map((key) => `META:${key}`);
    return prisma.$transaction(async (tx) => {
      const native = await tx.metaInsightDaily.deleteMany({
        where: {
          adAccountId,
          level: 'AD',
          date: { gte: since, lte: until },
          insightKey: { notIn: insightKeys },
        },
      });
      await tx.advertisingDailyMetric.deleteMany({
        where: {
          accountId: adAccountId,
          level: 'AD',
          date: { gte: since, lte: until },
          metricKey: { notIn: canonicalKeys },
        },
      });
      return native;
    });
  }

  async listDaily(
    storeId: string,
    input: { from: Date; to: Date; adId?: string; page: number; limit: number },
  ) {
    const connection = await prisma.metaConnection.findUnique({
      where: { storeId },
      select: { selectedAdAccountIds: true },
    });
    const selectedIds = connection?.selectedAdAccountIds ?? [];
    if (selectedIds.length === 0) return { items: [], total: 0 };

    const where = {
      adAccount: { storeId, metaAccountId: { in: selectedIds } },
      level: 'AD' as const,
      date: { gte: input.from, lte: input.to },
      ...(input.adId ? { ad: { metaAdId: input.adId } } : {}),
    } satisfies Prisma.MetaInsightDailyWhereInput;
    const [items, total] = await prisma.$transaction([
      prisma.metaInsightDaily.findMany({
        where,
        select: {
          date: true,
          accountCurrency: true,
          spend: true,
          socialSpend: true,
          impressions: true,
          reach: true,
          clicks: true,
          uniqueClicks: true,
          outboundClicks: true,
          uniqueOutboundClicks: true,
          inlineLinkClicks: true,
          inlinePostEngagement: true,
          cpc: true,
          cpm: true,
          cpp: true,
          ctr: true,
          frequency: true,
          objective: true,
          optimizationGoal: true,
          attributionSetting: true,
          actionReportTime: true,
          campaign: { select: { metaCampaignId: true, name: true } },
          adSet: { select: { metaAdSetId: true, name: true, learningStageInfo: true } },
          ad: { select: { metaAdId: true, name: true } },
          actions: {
            select: {
              kind: true,
              actionType: true,
              actionDestination: true,
              value: true,
              attributionWindow: true,
            },
          },
        },
        orderBy: [{ date: 'desc' }, { adId: 'asc' }],
        skip: (input.page - 1) * input.limit,
        take: input.limit,
      }),
      prisma.metaInsightDaily.count({ where }),
    ]);
    return { items, total };
  }
}
