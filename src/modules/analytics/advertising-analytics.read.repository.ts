import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { AdvertisingReadRepository } from '../advertising/advertising-read.repository.js';

const overviewMetricSelect = {
  date: true,
  accountCurrency: true,
  spend: true,
  impressions: true,
  clicks: true,
  frequency: true,
  attributionSetting: true,
  actions: {
    where: {
      kind: { in: ['ACTION', 'ACTION_VALUE', 'PURCHASE_ROAS', 'WEBSITE_PURCHASE_ROAS'] },
    },
    select: {
      kind: true,
      actionType: true,
      actionDestination: true,
      value: true,
    },
  },
} satisfies Prisma.MetaInsightDailySelect;

/** Legacy characterization shape retained only for parity/regression tests. */
export type AdvertisingOverviewMetricRow = Prisma.MetaInsightDailyGetPayload<{
  select: typeof overviewMetricSelect;
}>;

export type AdvertisingOverviewPeriod = 'CURRENT' | 'COMPARISON';

export interface AdvertisingOverviewAggregateRow {
  period: AdvertisingOverviewPeriod;
  accountCurrency: string;
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  purchaseValue: number;
  weightedFrequency: number;
  attributionSettings: string[];
}

export interface AdvertisingOverviewMeta {
  campaigns: number;
  ads: number;
  lastInsightsSyncedAt: Date | null;
}

export class AdvertisingAnalyticsReadRepository {
  constructor(
    private readonly canonical: AdvertisingReadRepository = new AdvertisingReadRepository(),
  ) {}

  /**
   * Native Meta characterization path retained until the provider-native tables are finally removed.
   * Runtime overview aggregation no longer depends on this method.
   */
  getOverviewMetricRows(
    storeId: string,
    selectedAccountIds: string[],
    from: Date,
    to: Date,
  ): Promise<AdvertisingOverviewMetricRow[]> {
    if (selectedAccountIds.length === 0) return Promise.resolve([]);
    return prisma.metaInsightDaily.findMany({
      where: {
        level: 'AD',
        date: { gte: from, lte: to },
        adAccount: { storeId, metaAccountId: { in: selectedAccountIds } },
      },
      select: overviewMetricSelect,
      orderBy: [{ date: 'asc' }, { id: 'asc' }],
    });
  }

  async getOverviewAggregateRows(input: {
    storeId: string;
    selectedAccountIds: string[];
    currentFrom: Date;
    currentTo: Date;
    comparisonFrom: Date;
    comparisonTo: Date;
  }): Promise<AdvertisingOverviewAggregateRow[]> {
    const rows = await this.canonical.getOverviewAggregateRows({
      storeId: input.storeId,
      provider: 'META',
      selectedAccountExternalIds: input.selectedAccountIds,
      currentFrom: input.currentFrom,
      currentTo: input.currentTo,
      comparisonFrom: input.comparisonFrom,
      comparisonTo: input.comparisonTo,
    });
    return rows
      .filter((row): row is typeof row & { currency: string } => row.currency !== null)
      .map((row) => ({
        period: row.period,
        accountCurrency: row.currency,
        spend: row.spend,
        impressions: row.impressions,
        clicks: row.clicks,
        purchases: row.conversions,
        purchaseValue: row.conversionValue,
        weightedFrequency: row.weightedFrequency,
        attributionSettings: row.attributionSettings,
      }));
  }

  async getOverviewMeta(
    storeId: string,
    selectedAccountIds: string[],
  ): Promise<AdvertisingOverviewMeta> {
    if (selectedAccountIds.length === 0) {
      return { campaigns: 0, ads: 0, lastInsightsSyncedAt: null };
    }

    const [canonicalMeta, latestSync] = await Promise.all([
      this.canonical.getOverviewMeta({
        storeId,
        provider: 'META',
        selectedAccountExternalIds: selectedAccountIds,
      }),
      prisma.syncRun.findFirst({
        where: {
          provider: 'META',
          resourceType: 'AdInsightsDaily',
          status: 'SUCCEEDED',
          metaConnection: { is: { storeId } },
        },
        orderBy: { createdAt: 'desc' },
        select: { finishedAt: true },
      }),
    ]);

    return {
      campaigns: canonicalMeta.campaigns,
      ads: canonicalMeta.ads,
      // Preserve the public definition of "last insights sync" while hierarchy/count evidence comes
      // from canonical persistence. SyncRun is operational metadata, not provider fact storage.
      lastInsightsSyncedAt: latestSync?.finishedAt ?? null,
    };
  }
}
