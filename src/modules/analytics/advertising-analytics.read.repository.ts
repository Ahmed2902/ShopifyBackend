import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';

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

export type AdvertisingOverviewMetricRow = Prisma.MetaInsightDailyGetPayload<{
  select: typeof overviewMetricSelect;
}>;

export interface AdvertisingOverviewMeta {
  campaigns: number;
  ads: number;
  lastInsightsSyncedAt: Date | null;
}

export class AdvertisingAnalyticsReadRepository {
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

  async getOverviewMeta(
    storeId: string,
    selectedAccountIds: string[],
  ): Promise<AdvertisingOverviewMeta> {
    if (selectedAccountIds.length === 0) {
      return { campaigns: 0, ads: 0, lastInsightsSyncedAt: null };
    }

    const accountIds = Prisma.join(selectedAccountIds.map((id) => Prisma.sql`${id}`));
    const [row] = await prisma.$queryRaw<
      Array<{
        campaigns: bigint;
        ads: bigint;
        last_insights_synced_at: Date | null;
      }>
    >(Prisma.sql`
      SELECT
        (
          SELECT COUNT(*)
          FROM "MetaCampaign" campaign
          INNER JOIN "MetaAdAccount" account ON account."id" = campaign."adAccountId"
          WHERE account."storeId" = ${storeId}::uuid
            AND account."metaAccountId" IN (${accountIds})
            AND campaign."deletedAt" IS NULL
        ) AS campaigns,
        (
          SELECT COUNT(*)
          FROM "MetaAd" ad
          INNER JOIN "MetaAdAccount" account ON account."id" = ad."adAccountId"
          WHERE account."storeId" = ${storeId}::uuid
            AND account."metaAccountId" IN (${accountIds})
            AND ad."deletedAt" IS NULL
        ) AS ads,
        (
          SELECT MAX(insight."syncedAt")
          FROM "MetaInsightDaily" insight
          INNER JOIN "MetaAdAccount" account ON account."id" = insight."adAccountId"
          WHERE account."storeId" = ${storeId}::uuid
            AND account."metaAccountId" IN (${accountIds})
            AND insight."level" = 'AD'
        ) AS last_insights_synced_at
    `);

    return {
      campaigns: Number(row?.campaigns ?? 0),
      ads: Number(row?.ads ?? 0),
      lastInsightsSyncedAt: row?.last_insights_synced_at ?? null,
    };
  }
}
