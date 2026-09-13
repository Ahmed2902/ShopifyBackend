import { createHash } from 'node:crypto';
import { Prisma, type MetaInsightActionKind } from '../../../generated/prisma/client.js';
import { AppError } from '../../../errors/app-error.js';
import { prisma } from '../../../lib/prisma.js';
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
        select: { id: true, metaAdId: true, creativeId: true, metaUpdatedAt: true },
      }),
    ]);
    return {
      campaigns: new Map(campaigns.map((item) => [item.metaCampaignId, item.id])),
      adSets: new Map(adSets.map((item) => [item.metaAdSetId, item.id])),
      ads: new Map(ads.map((item) => [item.metaAdId, item.id])),
      adCreatives: new Map(
        ads.map((item) => [
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
        select: { id: true },
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
      return insightKey;
    });
  }

  deleteMissingRange(adAccountId: string, since: Date, until: Date, insightKeys: string[]) {
    return prisma.metaInsightDaily.deleteMany({
      where: {
        adAccountId,
        level: 'AD',
        date: { gte: since, lte: until },
        insightKey: { notIn: insightKeys },
      },
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
