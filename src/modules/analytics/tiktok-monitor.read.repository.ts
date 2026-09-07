import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import type { TikTokMonitorQuery } from './tiktok-monitor.schema.js';

export type TikTokMonitorLevel = TikTokMonitorQuery['level'];

type RawSummaryRow = {
  account_currency: string | null;
  row_count: bigint;
  spend: Prisma.Decimal | string | number | null;
  impressions: bigint | number | null;
  clicks: bigint | number | null;
  conversions: Prisma.Decimal | string | number | null;
  conversion_value: Prisma.Decimal | string | number | null;
  weighted_frequency: Prisma.Decimal | string | number | null;
};

type RawEntityMetricRow = {
  entity_id: string;
  account_currency: string | null;
  spend: Prisma.Decimal | string | number | null;
  impressions: bigint | number | null;
  clicks: bigint | number | null;
  conversions: Prisma.Decimal | string | number | null;
  conversion_value: Prisma.Decimal | string | number | null;
};

type RawCountsRow = {
  campaigns: bigint;
  groups: bigint;
  ads: bigint;
};

export type TikTokMonitorMetric = {
  currency: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
  roas: number | null;
  ctr: number | null;
  cpc: number | null;
};

export type TikTokMonitorHierarchyItem = {
  id: string;
  externalId: string;
  name: string;
  status: string | null;
  secondaryStatus: string | null;
  parentName: string | null;
  objective: string | null;
  thumbnailUrl: string | null;
  targetScope: string | null;
  metric: TikTokMonitorMetric | null;
};

function numeric(value: Prisma.Decimal | string | number | bigint | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function metric(input: {
  currency: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number;
  conversionValue: number;
}): TikTokMonitorMetric {
  return {
    ...input,
    roas: input.spend > 0 && input.conversionValue > 0 ? input.conversionValue / input.spend : null,
    ctr: input.impressions > 0 ? (input.clicks / input.impressions) * 100 : null,
    cpc: input.clicks > 0 ? input.spend / input.clicks : null,
  };
}

export class TikTokMonitorReadRepository {
  getConnection(storeId: string) {
    return prisma.tikTokConnection.findUnique({
      where: { storeId },
      select: {
        status: true,
        selectedAdvertiserIds: true,
        lastSyncedAt: true,
      },
    });
  }

  async getCounts(storeId: string, selectedAdvertiserIds: string[]) {
    if (selectedAdvertiserIds.length === 0) return { campaigns: 0, groups: 0, ads: 0 };
    const advertiserIds = Prisma.join(selectedAdvertiserIds.map((id) => Prisma.sql`${id}`));
    const [row] = await prisma.$queryRaw<RawCountsRow[]>(Prisma.sql`
      SELECT
        (
          SELECT COUNT(*)
          FROM "TikTokCampaign" campaign
          INNER JOIN "TikTokAdvertiser" advertiser ON advertiser."id" = campaign."advertiserDbId"
          WHERE advertiser."storeId" = ${storeId}::uuid
            AND advertiser."advertiserId" IN (${advertiserIds})
            AND campaign."deletedAt" IS NULL
        ) AS campaigns,
        (
          SELECT COUNT(*)
          FROM "TikTokAdGroup" ad_group
          INNER JOIN "TikTokAdvertiser" advertiser ON advertiser."id" = ad_group."advertiserDbId"
          WHERE advertiser."storeId" = ${storeId}::uuid
            AND advertiser."advertiserId" IN (${advertiserIds})
            AND ad_group."deletedAt" IS NULL
        ) AS groups,
        (
          SELECT COUNT(*)
          FROM "TikTokAd" ad
          INNER JOIN "TikTokAdvertiser" advertiser ON advertiser."id" = ad."advertiserDbId"
          WHERE advertiser."storeId" = ${storeId}::uuid
            AND advertiser."advertiserId" IN (${advertiserIds})
            AND ad."deletedAt" IS NULL
        ) AS ads
    `);
    return {
      campaigns: Number(row?.campaigns ?? 0),
      groups: Number(row?.groups ?? 0),
      ads: Number(row?.ads ?? 0),
    };
  }

  async getSummary(storeId: string, selectedAdvertiserIds: string[], from: Date, to: Date) {
    if (selectedAdvertiserIds.length === 0) return [];
    const advertiserIds = Prisma.join(selectedAdvertiserIds.map((id) => Prisma.sql`${id}`));
    const rows = await prisma.$queryRaw<RawSummaryRow[]>(Prisma.sql`
      SELECT
        insight."accountCurrency" AS account_currency,
        COUNT(*) AS row_count,
        COALESCE(SUM(insight."spend"), 0) AS spend,
        COALESCE(SUM(insight."impressions"), 0) AS impressions,
        COALESCE(SUM(insight."clicks"), 0) AS clicks,
        COALESCE(SUM(insight."conversions"), 0) AS conversions,
        COALESCE(SUM(insight."conversionValue"), 0) AS conversion_value,
        COALESCE(
          SUM(
            CASE
              WHEN insight."frequency" IS NOT NULL AND insight."impressions" > 0
                THEN insight."frequency" * insight."impressions"
              ELSE 0
            END
          ),
          0
        ) AS weighted_frequency
      FROM "TikTokInsightDaily" insight
      INNER JOIN "TikTokAdvertiser" advertiser ON advertiser."id" = insight."advertiserDbId"
      WHERE advertiser."storeId" = ${storeId}::uuid
        AND advertiser."advertiserId" IN (${advertiserIds})
        AND insight."level" = 'AD'
        AND insight."date" BETWEEN ${from} AND ${to}
      GROUP BY insight."accountCurrency"
      ORDER BY insight."accountCurrency" NULLS LAST
    `);

    return rows.map((row) => {
      const spend = numeric(row.spend);
      const impressions = numeric(row.impressions);
      const clicks = numeric(row.clicks);
      const conversions = numeric(row.conversions);
      const conversionValue = numeric(row.conversion_value);
      return {
        ...metric({
          currency: row.account_currency,
          spend,
          impressions,
          clicks,
          conversions,
          conversionValue,
        }),
        rowCount: Number(row.row_count),
        frequency: impressions > 0 ? numeric(row.weighted_frequency) / impressions : null,
      };
    });
  }

  async getHierarchyPage(input: {
    storeId: string;
    selectedAdvertiserIds: string[];
    level: TikTokMonitorLevel;
    page: number;
    limit: number;
  }): Promise<Omit<TikTokMonitorHierarchyItem, 'metric'>[]> {
    if (input.selectedAdvertiserIds.length === 0) return [];
    const skip = (input.page - 1) * input.limit;
    const advertiser = {
      storeId: input.storeId,
      advertiserId: { in: input.selectedAdvertiserIds },
    } as const;

    if (input.level === 'campaigns') {
      const rows = await prisma.tikTokCampaign.findMany({
        where: { advertiser, deletedAt: null },
        orderBy: [{ tiktokUpdatedAt: 'desc' }, { id: 'desc' }],
        skip,
        take: input.limit,
        select: {
          id: true,
          tiktokCampaignId: true,
          name: true,
          operationStatus: true,
          secondaryStatus: true,
          objectiveType: true,
        },
      });
      return rows.map((row) => ({
        id: row.id,
        externalId: row.tiktokCampaignId,
        name: row.name,
        status: row.operationStatus,
        secondaryStatus: row.secondaryStatus,
        parentName: null,
        objective: row.objectiveType,
        thumbnailUrl: null,
        targetScope: null,
      }));
    }

    if (input.level === 'groups') {
      const rows = await prisma.tikTokAdGroup.findMany({
        where: { advertiser, deletedAt: null },
        orderBy: [{ tiktokUpdatedAt: 'desc' }, { id: 'desc' }],
        skip,
        take: input.limit,
        select: {
          id: true,
          tiktokAdGroupId: true,
          name: true,
          operationStatus: true,
          secondaryStatus: true,
          optimizationGoal: true,
          campaign: { select: { name: true } },
        },
      });
      return rows.map((row) => ({
        id: row.id,
        externalId: row.tiktokAdGroupId,
        name: row.name,
        status: row.operationStatus,
        secondaryStatus: row.secondaryStatus,
        parentName: row.campaign.name,
        objective: row.optimizationGoal,
        thumbnailUrl: null,
        targetScope: null,
      }));
    }

    const rows = await prisma.tikTokAd.findMany({
      where: { advertiser, deletedAt: null },
      orderBy: [{ tiktokUpdatedAt: 'desc' }, { id: 'desc' }],
      skip,
      take: input.limit,
      select: {
        id: true,
        tiktokAdId: true,
        name: true,
        operationStatus: true,
        secondaryStatus: true,
        thumbnailUrl: true,
        targetScope: true,
        campaign: { select: { name: true } },
        adGroup: { select: { name: true } },
      },
    });
    return rows.map((row) => ({
      id: row.id,
      externalId: row.tiktokAdId,
      name: row.name,
      status: row.operationStatus,
      secondaryStatus: row.secondaryStatus,
      parentName: `${row.campaign.name} · ${row.adGroup.name}`,
      objective: null,
      thumbnailUrl: row.thumbnailUrl,
      targetScope: row.targetScope,
    }));
  }

  async getEntityMetrics(input: {
    storeId: string;
    selectedAdvertiserIds: string[];
    level: TikTokMonitorLevel;
    entityIds: string[];
    from: Date;
    to: Date;
  }): Promise<Map<string, TikTokMonitorMetric>> {
    if (input.entityIds.length === 0 || input.selectedAdvertiserIds.length === 0) return new Map();
    const advertiserIds = Prisma.join(input.selectedAdvertiserIds.map((id) => Prisma.sql`${id}`));
    const entityIds = Prisma.join(input.entityIds.map((id) => Prisma.sql`${id}::uuid`));
    const entityColumn =
      input.level === 'campaigns'
        ? Prisma.sql`insight."campaignId"`
        : input.level === 'groups'
          ? Prisma.sql`insight."adGroupId"`
          : Prisma.sql`insight."adId"`;

    const rows = await prisma.$queryRaw<RawEntityMetricRow[]>(Prisma.sql`
      SELECT
        ${entityColumn} AS entity_id,
        insight."accountCurrency" AS account_currency,
        COALESCE(SUM(insight."spend"), 0) AS spend,
        COALESCE(SUM(insight."impressions"), 0) AS impressions,
        COALESCE(SUM(insight."clicks"), 0) AS clicks,
        COALESCE(SUM(insight."conversions"), 0) AS conversions,
        COALESCE(SUM(insight."conversionValue"), 0) AS conversion_value
      FROM "TikTokInsightDaily" insight
      INNER JOIN "TikTokAdvertiser" advertiser ON advertiser."id" = insight."advertiserDbId"
      WHERE advertiser."storeId" = ${input.storeId}::uuid
        AND advertiser."advertiserId" IN (${advertiserIds})
        AND insight."level" = 'AD'
        AND insight."date" BETWEEN ${input.from} AND ${input.to}
        AND ${entityColumn} IN (${entityIds})
      GROUP BY ${entityColumn}, insight."accountCurrency"
      ORDER BY ${entityColumn}, insight."accountCurrency" NULLS LAST
    `);

    const grouped = new Map<string, TikTokMonitorMetric[]>();
    for (const row of rows) {
      if (!row.entity_id) continue;
      const value = metric({
        currency: row.account_currency,
        spend: numeric(row.spend),
        impressions: numeric(row.impressions),
        clicks: numeric(row.clicks),
        conversions: numeric(row.conversions),
        conversionValue: numeric(row.conversion_value),
      });
      const values = grouped.get(row.entity_id) ?? [];
      values.push(value);
      grouped.set(row.entity_id, values);
    }

    const result = new Map<string, TikTokMonitorMetric>();
    for (const [entityId, values] of grouped) {
      if (values.length === 1) result.set(entityId, values[0]!);
      else {
        const impressions = values.reduce((sum, value) => sum + value.impressions, 0);
        const clicks = values.reduce((sum, value) => sum + value.clicks, 0);
        const conversions = values.reduce((sum, value) => sum + value.conversions, 0);
        // Money cannot be blended across currencies. Delivery remains useful, while monetary
        // values are withheld by returning a null currency and zero spend/value.
        result.set(
          entityId,
          metric({ currency: null, spend: 0, impressions, clicks, conversions, conversionValue: 0 }),
        );
      }
    }
    return result;
  }
}
