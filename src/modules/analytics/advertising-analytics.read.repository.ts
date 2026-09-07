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

type RawAdvertisingOverviewAggregateRow = {
  period: AdvertisingOverviewPeriod;
  account_currency: string;
  spend: Prisma.Decimal | string | number | null;
  impressions: bigint | number | null;
  clicks: bigint | number | null;
  purchases: Prisma.Decimal | string | number | null;
  purchase_value: Prisma.Decimal | string | number | null;
  weighted_frequency: Prisma.Decimal | string | number | null;
  attribution_settings: string[] | null;
};

export interface AdvertisingOverviewMeta {
  campaigns: number;
  ads: number;
  lastInsightsSyncedAt: Date | null;
}

function numeric(value: Prisma.Decimal | string | number | bigint | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class AdvertisingAnalyticsReadRepository {
  /**
   * Characterization/read-detail path retained for tests and entity detail surfaces.
   * Production overview uses getOverviewAggregateRows so it does not materialize every
   * AD-day insight and nested action row into Node.
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
    if (input.selectedAccountIds.length === 0) return [];

    const accountIds = Prisma.join(
      input.selectedAccountIds.map((id) => Prisma.sql`${id}`),
    );
    const rows = await prisma.$queryRaw<RawAdvertisingOverviewAggregateRow[]>(Prisma.sql`
      WITH scoped_insights AS (
        SELECT
          insight."id",
          CASE
            WHEN insight."date" BETWEEN ${input.currentFrom} AND ${input.currentTo}
              THEN 'CURRENT'
            ELSE 'COMPARISON'
          END AS period,
          insight."accountCurrency" AS account_currency,
          insight."spend",
          insight."impressions",
          insight."clicks",
          insight."frequency",
          insight."attributionSetting" AS attribution_setting
        FROM "MetaInsightDaily" insight
        INNER JOIN "MetaAdAccount" account ON account."id" = insight."adAccountId"
        WHERE account."storeId" = ${input.storeId}::uuid
          AND account."metaAccountId" IN (${accountIds})
          AND insight."level" = 'AD'
          AND (
            insight."date" BETWEEN ${input.currentFrom} AND ${input.currentTo}
            OR insight."date" BETWEEN ${input.comparisonFrom} AND ${input.comparisonTo}
          )
      ),
      action_type_totals AS (
        SELECT
          action."insightId" AS insight_id,
          action."kind"::text AS kind,
          action."actionType" AS action_type,
          SUM(action."value") AS summed_value,
          MAX(action."value") FILTER (WHERE action."value" > 0) AS max_positive_value,
          CASE
            WHEN action."actionType" = 'offsite_conversion.fb_pixel_purchase' THEN 0
            WHEN action."actionType" = 'omni_purchase' THEN 1
            WHEN action."actionType" = 'purchase' THEN 2
            WHEN LOWER(action."actionType") LIKE '%purchase%' THEN 3
            ELSE 100
          END AS purchase_rank
        FROM "MetaInsightAction" action
        INNER JOIN scoped_insights scoped ON scoped."id" = action."insightId"
        WHERE action."kind" IN ('ACTION', 'ACTION_VALUE', 'PURCHASE_ROAS', 'WEBSITE_PURCHASE_ROAS')
          AND (
            action."actionType" IN (
              'offsite_conversion.fb_pixel_purchase',
              'omni_purchase',
              'purchase'
            )
            OR LOWER(action."actionType") LIKE '%purchase%'
          )
        GROUP BY action."insightId", action."kind", action."actionType"
      ),
      ranked_actions AS (
        SELECT
          totals.*,
          ROW_NUMBER() OVER (
            PARTITION BY totals.insight_id, totals.kind
            ORDER BY totals.purchase_rank ASC, totals.action_type ASC
          ) AS type_rank
        FROM action_type_totals totals
        WHERE totals.purchase_rank < 100
      ),
      selected_actions AS (
        SELECT
          ranked.insight_id,
          MAX(ranked.summed_value) FILTER (
            WHERE ranked.kind = 'ACTION' AND ranked.type_rank = 1
          ) AS purchases,
          MAX(ranked.summed_value) FILTER (
            WHERE ranked.kind = 'ACTION_VALUE' AND ranked.type_rank = 1
          ) AS direct_purchase_value,
          MAX(ranked.max_positive_value) FILTER (
            WHERE ranked.kind = 'WEBSITE_PURCHASE_ROAS' AND ranked.type_rank = 1
          ) AS website_purchase_roas,
          MAX(ranked.max_positive_value) FILTER (
            WHERE ranked.kind = 'PURCHASE_ROAS' AND ranked.type_rank = 1
          ) AS purchase_roas
        FROM ranked_actions ranked
        GROUP BY ranked.insight_id
      )
      SELECT
        scoped.period,
        scoped.account_currency,
        COALESCE(SUM(scoped."spend"), 0) AS spend,
        COALESCE(SUM(scoped."impressions"), 0) AS impressions,
        COALESCE(SUM(scoped."clicks"), 0) AS clicks,
        COALESCE(SUM(actions.purchases), 0) AS purchases,
        COALESCE(
          SUM(
            CASE
              WHEN COALESCE(actions.direct_purchase_value, 0) > 0
                THEN actions.direct_purchase_value
              ELSE scoped."spend" * COALESCE(
                actions.website_purchase_roas,
                actions.purchase_roas,
                0
              )
            END
          ),
          0
        ) AS purchase_value,
        COALESCE(
          SUM(
            CASE
              WHEN scoped."frequency" IS NOT NULL AND scoped."impressions" > 0
                THEN scoped."frequency" * scoped."impressions"
              ELSE 0
            END
          ),
          0
        ) AS weighted_frequency,
        COALESCE(
          ARRAY_AGG(DISTINCT scoped.attribution_setting) FILTER (
            WHERE scoped.attribution_setting IS NOT NULL AND scoped.attribution_setting <> ''
          ),
          ARRAY[]::text[]
        ) AS attribution_settings
      FROM scoped_insights scoped
      LEFT JOIN selected_actions actions ON actions.insight_id = scoped."id"
      GROUP BY scoped.period, scoped.account_currency
      ORDER BY scoped.period, scoped.account_currency
    `);

    return rows.map((row) => ({
      period: row.period,
      accountCurrency: row.account_currency,
      spend: numeric(row.spend),
      impressions: numeric(row.impressions),
      clicks: numeric(row.clicks),
      purchases: numeric(row.purchases),
      purchaseValue: numeric(row.purchase_value),
      weightedFrequency: numeric(row.weighted_frequency),
      attributionSettings: row.attribution_settings ?? [],
    }));
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
          SELECT sync."finishedAt"
          FROM "SyncRun" sync
          INNER JOIN "MetaConnection" connection ON connection."id" = sync."metaConnectionId"
          WHERE connection."storeId" = ${storeId}::uuid
            AND sync."provider" = 'META'
            AND sync."resourceType" = 'AdInsightsDaily'
            AND sync."status" = 'SUCCEEDED'
          ORDER BY sync."createdAt" DESC
          LIMIT 1
        ) AS last_insights_synced_at
    `);

    return {
      campaigns: Number(row?.campaigns ?? 0),
      ads: Number(row?.ads ?? 0),
      lastInsightsSyncedAt: row?.last_insights_synced_at ?? null,
    };
  }
}
