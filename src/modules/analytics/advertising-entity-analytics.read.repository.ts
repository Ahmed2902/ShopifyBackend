import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';

export type AdvertisingEntityKind = 'CAMPAIGN' | 'ADSET' | 'AD' | 'CREATIVE';
export type AdvertisingEntityPeriod = 'CURRENT' | 'COMPARISON';

export interface AdvertisingEntityAggregateRow {
  period: AdvertisingEntityPeriod;
  entityId: string;
  accountCurrency: string;
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  purchaseValue: number;
  weightedFrequency: number;
}

type RawAggregateRow = {
  period: AdvertisingEntityPeriod;
  entity_id: string;
  account_currency: string;
  spend: Prisma.Decimal | string | number | null;
  impressions: bigint | number | null;
  clicks: bigint | number | null;
  purchases: Prisma.Decimal | string | number | null;
  purchase_value: Prisma.Decimal | string | number | null;
  weighted_frequency: Prisma.Decimal | string | number | null;
};

function numeric(value: Prisma.Decimal | string | number | bigint | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function entityColumn(kind: AdvertisingEntityKind) {
  if (kind === 'CAMPAIGN') return Prisma.raw('insight."campaignId"');
  if (kind === 'ADSET') return Prisma.raw('insight."adSetId"');
  if (kind === 'AD') return Prisma.raw('insight."adId"');
  return Prisma.raw('insight."creativeIdSnapshot"');
}

export class AdvertisingEntityAnalyticsReadRepository {
  async getAggregateRows(input: {
    storeId: string;
    selectedAccountIds: string[];
    entityIds: string[];
    kind: AdvertisingEntityKind;
    currentFrom: Date;
    currentTo: Date;
    comparisonFrom: Date;
    comparisonTo: Date;
  }): Promise<AdvertisingEntityAggregateRow[]> {
    if (input.selectedAccountIds.length === 0 || input.entityIds.length === 0) return [];

    const accountIds = Prisma.join(input.selectedAccountIds.map((id) => Prisma.sql`${id}`));
    const entityIds = Prisma.join(input.entityIds.map((id) => Prisma.sql`${id}::uuid`));
    const column = entityColumn(input.kind);

    const rows = await prisma.$queryRaw<RawAggregateRow[]>(Prisma.sql`
      WITH scoped_insights AS (
        SELECT
          insight."id",
          ${column} AS entity_id,
          CASE
            WHEN insight."date" BETWEEN ${input.currentFrom} AND ${input.currentTo}
              THEN 'CURRENT'
            ELSE 'COMPARISON'
          END AS period,
          insight."accountCurrency" AS account_currency,
          insight."spend",
          insight."impressions",
          insight."clicks",
          insight."frequency"
        FROM "MetaInsightDaily" insight
        INNER JOIN "MetaAdAccount" account ON account."id" = insight."adAccountId"
        WHERE account."storeId" = ${input.storeId}::uuid
          AND account."metaAccountId" IN (${accountIds})
          AND insight."level" = 'AD'
          AND ${column} IN (${entityIds})
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
        scoped.entity_id,
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
        ) AS weighted_frequency
      FROM scoped_insights scoped
      LEFT JOIN selected_actions actions ON actions.insight_id = scoped."id"
      WHERE scoped.entity_id IS NOT NULL
      GROUP BY scoped.period, scoped.entity_id, scoped.account_currency
      ORDER BY scoped.entity_id, scoped.period, scoped.account_currency
    `);

    return rows.map((row) => ({
      period: row.period,
      entityId: row.entity_id,
      accountCurrency: row.account_currency,
      spend: numeric(row.spend),
      impressions: numeric(row.impressions),
      clicks: numeric(row.clicks),
      purchases: numeric(row.purchases),
      purchaseValue: numeric(row.purchase_value),
      weightedFrequency: numeric(row.weighted_frequency),
    }));
  }
}
