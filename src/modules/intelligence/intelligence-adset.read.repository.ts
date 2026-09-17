import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import type { PaidEntityEvidence } from './paid-entity-intelligence.metrics.js';

const PURCHASE_ACTION_TYPE = 'offsite_conversion.fb_pixel_purchase';

type RawAdSetEvidenceRow = {
  period: 'CURRENT' | 'COMPARISON';
  account_currency: string;
  ad_set_id: string;
  ad_set_external_id: string;
  ad_set_name: string;
  spend: Prisma.Decimal | string | number | null;
  impressions: bigint | number | null;
  clicks: bigint | number | null;
  purchases: Prisma.Decimal | string | number | null;
  purchase_value: Prisma.Decimal | string | number | null;
};

function numeric(value: Prisma.Decimal | string | number | bigint | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Period-level ad-set evidence built from the already-normalized AD insight rows.
 *
 * Meta reach is deliberately not summed across child ads, so frequency is left null.
 * Purchase actions use the same priority/fallback semantics as the main intelligence read.
 */
export class IntelligenceAdSetReadRepository {
  async getEvidence(input: {
    storeId: string;
    selectedAccountIds: string[];
    currentFrom: Date;
    currentTo: Date;
    comparisonFrom: Date;
    comparisonTo: Date;
  }): Promise<PaidEntityEvidence[]> {
    if (input.selectedAccountIds.length === 0) return [];

    const accountIds = Prisma.join(input.selectedAccountIds.map((id) => Prisma.sql`${id}`));
    const rows = await prisma.$queryRaw<RawAdSetEvidenceRow[]>(Prisma.sql`
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
          ad_set."id" AS ad_set_id,
          ad_set."metaAdSetId" AS ad_set_external_id,
          ad_set."name" AS ad_set_name
        FROM "MetaInsightDaily" insight
        INNER JOIN "MetaAdAccount" account ON account."id" = insight."adAccountId"
        INNER JOIN "MetaAdSet" ad_set ON ad_set."id" = insight."adSetId"
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
            WHEN action."actionType" = '${Prisma.raw(PURCHASE_ACTION_TYPE)}' THEN 0
            WHEN action."actionType" = 'omni_purchase' THEN 1
            WHEN action."actionType" = 'purchase' THEN 2
            WHEN LOWER(action."actionType") LIKE '%purchase%' THEN 3
            ELSE 100
          END AS purchase_rank
        FROM "MetaInsightAction" action
        INNER JOIN scoped_insights scoped ON scoped."id" = action."insightId"
        WHERE action."kind" IN ('ACTION', 'ACTION_VALUE', 'PURCHASE_ROAS', 'WEBSITE_PURCHASE_ROAS')
          AND (
            action."actionType" IN ('${Prisma.raw(PURCHASE_ACTION_TYPE)}', 'omni_purchase', 'purchase')
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
        scoped.ad_set_id,
        scoped.ad_set_external_id,
        scoped.ad_set_name,
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
        ) AS purchase_value
      FROM scoped_insights scoped
      LEFT JOIN selected_actions actions ON actions.insight_id = scoped."id"
      GROUP BY
        scoped.period,
        scoped.account_currency,
        scoped.ad_set_id,
        scoped.ad_set_external_id,
        scoped.ad_set_name
      ORDER BY scoped.account_currency, scoped.ad_set_id, scoped.period
    `);

    const groups = new Map<
      string,
      {
        entityId: string;
        externalEntityId: string;
        name: string;
        currency: string;
        current: PaidEntityEvidence['current'];
        comparison: PaidEntityEvidence['comparison'];
      }
    >();
    const currentSpendByCurrency = new Map<string, number>();

    const empty = (): PaidEntityEvidence['current'] => ({
      spend: 0,
      impressions: 0,
      reach: null,
      clicks: 0,
      purchases: 0,
      purchaseValue: 0,
      roas: null,
      cpa: null,
      ctr: null,
      cpc: null,
      cpm: null,
      frequency: null,
    });

    for (const row of rows) {
      const spend = numeric(row.spend);
      const impressions = numeric(row.impressions);
      const clicks = numeric(row.clicks);
      const purchases = numeric(row.purchases);
      const purchaseValue = numeric(row.purchase_value);
      const metrics: PaidEntityEvidence['current'] = {
        spend,
        impressions,
        reach: null,
        clicks,
        purchases,
        purchaseValue,
        roas: spend > 0 ? purchaseValue / spend : null,
        cpa: purchases > 0 ? spend / purchases : null,
        ctr: impressions > 0 ? clicks / impressions : null,
        cpc: clicks > 0 ? spend / clicks : null,
        cpm: impressions > 0 ? (spend / impressions) * 1_000 : null,
        frequency: null,
      };
      const key = `${row.account_currency}:${row.ad_set_id}`;
      const group = groups.get(key) ?? {
        entityId: row.ad_set_id,
        externalEntityId: row.ad_set_external_id,
        name: row.ad_set_name,
        currency: row.account_currency,
        current: empty(),
        comparison: empty(),
      };
      if (row.period === 'CURRENT') {
        group.current = metrics;
        currentSpendByCurrency.set(
          row.account_currency,
          (currentSpendByCurrency.get(row.account_currency) ?? 0) + spend,
        );
      } else {
        group.comparison = metrics;
      }
      groups.set(key, group);
    }

    return [...groups.values()].map((group) => ({
      ...group,
      spendShare:
        (currentSpendByCurrency.get(group.currency) ?? 0) > 0
          ? group.current.spend / (currentSpendByCurrency.get(group.currency) ?? 1)
          : 0,
    }));
  }
}
