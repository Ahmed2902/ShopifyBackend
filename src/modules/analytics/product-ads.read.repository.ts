import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';

export type ProductAdsPeriod = 'CURRENT' | 'COMPARISON';

export interface ProductAdsMetaAggregateRow {
  period: ProductAdsPeriod;
  adId: string | null;
  accountCurrency: string;
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  purchaseValue: number;
  weightedFrequency: number;
}

export interface ProductAdsMappingSummaryRow {
  metaAdId: string;
  productId: string;
  variantId: string | null;
  source: string;
  confidence: Prisma.Decimal;
  isMerchantConfirmed: boolean;
  product: {
    id: string;
    shopifyProductId: string;
    title: string;
    status: string;
    deletedAt: Date | null;
  };
}

export interface ProductAdsProductIdentity {
  id: string;
  shopifyProductId: string;
  title: string;
  status: string;
  deletedAt: Date | null;
}

type RawMetaAggregateRow = {
  period: ProductAdsPeriod;
  ad_id: string | null;
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

/**
 * Compact read side for Product × Ads list analytics.
 *
 * The previous workspace materialized every order line/refund/cost and every AD-day/action row
 * before paginating products. This repository deliberately returns only current active mapping
 * facts, product identity, and one Meta aggregate row per period/ad/currency.
 */
export class ProductAdsReadRepository {
  getActiveMappingSummaries(
    storeId: string,
    selectedAccountIds: string[],
  ): Promise<ProductAdsMappingSummaryRow[]> {
    if (selectedAccountIds.length === 0) return Promise.resolve([]);

    return prisma.adProductMapping.findMany({
      where: {
        validUntil: null,
        ad: {
          adAccount: {
            storeId,
            metaAccountId: { in: selectedAccountIds },
          },
        },
        product: { storeId },
      },
      select: {
        metaAdId: true,
        productId: true,
        variantId: true,
        source: true,
        confidence: true,
        isMerchantConfirmed: true,
        product: {
          select: {
            id: true,
            shopifyProductId: true,
            title: true,
            status: true,
            deletedAt: true,
          },
        },
      },
      orderBy: [{ metaAdId: 'asc' }, { productId: 'asc' }, { variantId: 'asc' }],
    }) as Promise<ProductAdsMappingSummaryRow[]>;
  }

  getProductIdentities(storeId: string, productIds: string[]): Promise<ProductAdsProductIdentity[]> {
    const ids = [...new Set(productIds)];
    if (ids.length === 0) return Promise.resolve([]);

    return prisma.product.findMany({
      where: { storeId, id: { in: ids } },
      select: {
        id: true,
        shopifyProductId: true,
        title: true,
        status: true,
        deletedAt: true,
      },
    });
  }

  async getMetaAdAggregates(input: {
    storeId: string;
    selectedAccountIds: string[];
    currentFrom: Date;
    currentTo: Date;
    comparisonFrom: Date;
    comparisonTo: Date;
    adIds?: string[];
  }): Promise<ProductAdsMetaAggregateRow[]> {
    if (input.selectedAccountIds.length === 0) return [];
    if (input.adIds && input.adIds.length === 0) return [];

    const accountIds = Prisma.join(
      input.selectedAccountIds.map((id) => Prisma.sql`${id}`),
    );
    const adFilter = input.adIds
      ? Prisma.sql`AND insight."adId" IN (${Prisma.join(
          input.adIds.map((id) => Prisma.sql`${id}::uuid`),
        )})`
      : Prisma.empty;

    const rows = await prisma.$queryRaw<RawMetaAggregateRow[]>(Prisma.sql`
      WITH scoped_insights AS (
        SELECT
          insight."id",
          CASE
            WHEN insight."date" BETWEEN ${input.currentFrom} AND ${input.currentTo}
              THEN 'CURRENT'
            ELSE 'COMPARISON'
          END AS period,
          insight."adId" AS ad_id,
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
          AND (
            insight."date" BETWEEN ${input.currentFrom} AND ${input.currentTo}
            OR insight."date" BETWEEN ${input.comparisonFrom} AND ${input.comparisonTo}
          )
          ${adFilter}
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
        scoped.ad_id,
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
      GROUP BY scoped.period, scoped.ad_id, scoped.account_currency
      ORDER BY scoped.period, scoped.account_currency, scoped.ad_id NULLS LAST
    `);

    return rows.map((row) => ({
      period: row.period,
      adId: row.ad_id,
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
