import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';

const SHARED_COLLECTION_MEMBER_LIMIT = 50;
const PURCHASE_ACTION_TYPE = 'offsite_conversion.fb_pixel_purchase';

function demandDateWhere(from: Date, to: Date) {
  return {
    OR: [
      { processedAt: { gte: from, lte: to } },
      { processedAt: null, shopifyCreatedAt: { gte: from, lte: to } },
    ],
  };
}

export type IntelligenceMetaEvidenceBucket = 'CURRENT' | 'COMPARISON' | 'PRODUCT_ONLY';

export interface IntelligenceMetaEvidenceRow {
  bucket: IntelligenceMetaEvidenceBucket;
  sourceRowCount: number;
  date: Date;
  syncedAt: Date;
  accountCurrency: string;
  spend: number;
  impressions: number;
  clicks: number;
  frequency: number | null;
  campaign: {
    id: string;
    metaCampaignId: string;
    name: string;
  } | null;
  ad: {
    id: string;
    metaAdId: string;
    name: string;
    creative: {
      id: string;
      metaCreativeId: string;
      name: string | null;
      title: string | null;
    } | null;
  } | null;
  actions: Array<{
    kind: 'ACTION' | 'ACTION_VALUE';
    actionType: string;
    actionDestination: null;
    value: number;
  }>;
}

type RawIntelligenceMetaEvidenceRow = {
  bucket: IntelligenceMetaEvidenceBucket;
  source_row_count: bigint;
  synced_at: Date | null;
  account_currency: string;
  spend: Prisma.Decimal | string | number | null;
  impressions: bigint | number | null;
  clicks: bigint | number | null;
  purchases: Prisma.Decimal | string | number | null;
  purchase_value: Prisma.Decimal | string | number | null;
  weighted_frequency: Prisma.Decimal | string | number | null;
  campaign_id: string | null;
  campaign_external_id: string | null;
  campaign_name: string | null;
  ad_id: string | null;
  ad_external_id: string | null;
  ad_name: string | null;
  creative_id: string | null;
  creative_external_id: string | null;
  creative_name: string | null;
  creative_title: string | null;
};

function numeric(value: Prisma.Decimal | string | number | bigint | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export class IntelligenceRepository {
  getStoreContext(storeId: string) {
    return prisma.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        currencyCode: true,
        ianaTimezone: true,
        inventoryIntelligenceMode: true,
        inventoryReviewedAt: true,
        shopifyConnection: {
          select: { status: true, scopes: true, lastSyncedAt: true },
        },
        metaConnection: {
          select: {
            status: true,
            selectedAdAccountIds: true,
          },
        },
      },
    });
  }

  getLatestOrderHistorySync(storeId: string) {
    return prisma.syncRun.findFirst({
      where: {
        provider: 'SHOPIFY',
        resourceType: 'OrdersRefunds',
        status: 'SUCCEEDED',
        shopifyConnection: { is: { storeId } },
      },
      orderBy: { createdAt: 'desc' },
      select: {
        status: true,
        recordsRead: true,
        recordsWritten: true,
        finishedAt: true,
      },
    });
  }

  getLatestMetaInsightSyncedAt(storeId: string, selectedAccountIds: string[]) {
    if (selectedAccountIds.length === 0) return Promise.resolve(null);
    return prisma.metaInsightDaily.findFirst({
      where: {
        level: 'AD',
        adAccount: { storeId, metaAccountId: { in: selectedAccountIds } },
      },
      orderBy: { syncedAt: 'desc' },
      select: { syncedAt: true },
    });
  }

  /**
   * Compact production evidence read. The rule layer still sees Meta-like rows, but PostgreSQL
   * first reduces daily/action history to at most three period buckets per ad/currency identity.
   * `sourceRowCount` preserves the original observation count for data-quality reporting.
   */
  async getMetaEvidenceRows(input: {
    storeId: string;
    selectedAccountIds: string[];
    productFrom: Date;
    currentFrom: Date;
    currentTo: Date;
    comparisonFrom: Date;
    comparisonTo: Date;
  }): Promise<IntelligenceMetaEvidenceRow[]> {
    if (input.selectedAccountIds.length === 0) return [];

    const accountIds = Prisma.join(
      input.selectedAccountIds.map((id) => Prisma.sql`${id}`),
    );
    const rows = await prisma.$queryRaw<RawIntelligenceMetaEvidenceRow[]>(Prisma.sql`
      WITH scoped_insights AS (
        SELECT
          insight."id",
          CASE
            WHEN insight."date" BETWEEN ${input.currentFrom} AND ${input.currentTo}
              THEN 'CURRENT'
            WHEN insight."date" BETWEEN ${input.comparisonFrom} AND ${input.comparisonTo}
              THEN 'COMPARISON'
            ELSE 'PRODUCT_ONLY'
          END AS bucket,
          insight."syncedAt" AS synced_at,
          insight."accountCurrency" AS account_currency,
          insight."spend",
          insight."impressions",
          insight."clicks",
          insight."frequency",
          campaign."id" AS campaign_id,
          campaign."metaCampaignId" AS campaign_external_id,
          campaign."name" AS campaign_name,
          ad."id" AS ad_id,
          ad."metaAdId" AS ad_external_id,
          ad."name" AS ad_name,
          creative."id" AS creative_id,
          creative."metaCreativeId" AS creative_external_id,
          creative."name" AS creative_name,
          creative."title" AS creative_title
        FROM "MetaInsightDaily" insight
        INNER JOIN "MetaAdAccount" account ON account."id" = insight."adAccountId"
        LEFT JOIN "MetaCampaign" campaign ON campaign."id" = insight."campaignId"
        LEFT JOIN "MetaAd" ad ON ad."id" = insight."adId"
        LEFT JOIN "MetaCreative" creative ON creative."id" = ad."creativeId"
        WHERE account."storeId" = ${input.storeId}::uuid
          AND account."metaAccountId" IN (${accountIds})
          AND insight."level" = 'AD'
          AND insight."date" BETWEEN ${input.productFrom} AND ${input.currentTo}
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
        scoped.bucket,
        COUNT(*) AS source_row_count,
        MAX(scoped.synced_at) AS synced_at,
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
        scoped.campaign_id,
        scoped.campaign_external_id,
        scoped.campaign_name,
        scoped.ad_id,
        scoped.ad_external_id,
        scoped.ad_name,
        scoped.creative_id,
        scoped.creative_external_id,
        scoped.creative_name,
        scoped.creative_title
      FROM scoped_insights scoped
      LEFT JOIN selected_actions actions ON actions.insight_id = scoped."id"
      GROUP BY
        scoped.bucket,
        scoped.account_currency,
        scoped.campaign_id,
        scoped.campaign_external_id,
        scoped.campaign_name,
        scoped.ad_id,
        scoped.ad_external_id,
        scoped.ad_name,
        scoped.creative_id,
        scoped.creative_external_id,
        scoped.creative_name,
        scoped.creative_title
      ORDER BY scoped.bucket, scoped.account_currency, scoped.ad_id NULLS LAST
    `);

    return rows.map((row) => {
      const impressions = numeric(row.impressions);
      const weightedFrequency = numeric(row.weighted_frequency);
      const purchases = numeric(row.purchases);
      const purchaseValue = numeric(row.purchase_value);
      const date =
        row.bucket === 'CURRENT'
          ? input.currentFrom
          : row.bucket === 'COMPARISON'
            ? input.comparisonFrom
            : input.productFrom;
      return {
        bucket: row.bucket,
        sourceRowCount: numeric(row.source_row_count),
        date,
        syncedAt: row.synced_at ?? date,
        accountCurrency: row.account_currency,
        spend: numeric(row.spend),
        impressions,
        clicks: numeric(row.clicks),
        frequency: impressions > 0 ? weightedFrequency / impressions : null,
        campaign:
          row.campaign_id && row.campaign_external_id && row.campaign_name
            ? {
                id: row.campaign_id,
                metaCampaignId: row.campaign_external_id,
                name: row.campaign_name,
              }
            : null,
        ad:
          row.ad_id && row.ad_external_id && row.ad_name
            ? {
                id: row.ad_id,
                metaAdId: row.ad_external_id,
                name: row.ad_name,
                creative:
                  row.creative_id && row.creative_external_id
                    ? {
                        id: row.creative_id,
                        metaCreativeId: row.creative_external_id,
                        name: row.creative_name,
                        title: row.creative_title,
                      }
                    : null,
              }
            : null,
        actions: [
          {
            kind: 'ACTION' as const,
            actionType: PURCHASE_ACTION_TYPE,
            actionDestination: null,
            value: purchases,
          },
          {
            kind: 'ACTION_VALUE' as const,
            actionType: PURCHASE_ACTION_TYPE,
            actionDestination: null,
            value: purchaseValue,
          },
        ],
      };
    });
  }

  /** Raw characterization path used to prove the aggregate read preserves rule semantics. */
  getMetaEvidenceRowsRaw(
    storeId: string,
    selectedAccountIds: string[],
    from: Date,
    to: Date,
  ) {
    if (selectedAccountIds.length === 0) return Promise.resolve([]);

    return prisma.metaInsightDaily.findMany({
      where: {
        level: 'AD',
        date: { gte: from, lte: to },
        adAccount: { storeId, metaAccountId: { in: selectedAccountIds } },
      },
      select: {
        date: true,
        syncedAt: true,
        accountCurrency: true,
        spend: true,
        impressions: true,
        clicks: true,
        frequency: true,
        campaign: {
          select: { id: true, metaCampaignId: true, name: true },
        },
        ad: {
          select: {
            id: true,
            metaAdId: true,
            name: true,
            creative: {
              select: { id: true, metaCreativeId: true, name: true, title: true },
            },
          },
        },
        actions: {
          where: {
            kind: { in: ['ACTION', 'ACTION_VALUE', 'PURCHASE_ROAS', 'WEBSITE_PURCHASE_ROAS'] },
          },
          select: { kind: true, actionType: true, actionDestination: true, value: true },
        },
      },
      orderBy: [{ date: 'asc' }, { adId: 'asc' }],
    });
  }

  getCommerceRows(storeId: string, from: Date, to: Date) {
    return prisma.orderLineItem.findMany({
      where: {
        order: {
          storeId,
          isTest: false,
          cancelledAt: null,
          ...demandDateWhere(from, to),
        },
        productId: { not: null },
      },
      select: {
        productId: true,
        variantId: true,
        quantity: true,
        discountedTotal: true,
        order: {
          select: { shopifyCreatedAt: true, processedAt: true, currencyCode: true },
        },
        product: {
          select: { id: true, shopifyProductId: true, title: true },
        },
        refundLines: {
          select: { quantity: true, subtotal: true, restocked: true },
        },
      },
      orderBy: [
        { order: { processedAt: 'asc' } },
        { order: { shopifyCreatedAt: 'asc' } },
      ],
    });
  }

  getVariantCosts(storeId: string, variantIds: string[], from: Date, to: Date) {
    if (variantIds.length === 0) return Promise.resolve([]);
    return prisma.variantCost.findMany({
      where: {
        variantId: { in: variantIds },
        variant: { storeId },
        effectiveFrom: { lte: to },
        OR: [{ effectiveUntil: null }, { effectiveUntil: { gte: from } }],
      },
      select: {
        variantId: true,
        amount: true,
        currency: true,
        effectiveFrom: true,
        effectiveUntil: true,
      },
      orderBy: [{ variantId: 'asc' }, { effectiveFrom: 'asc' }],
    });
  }

  getActiveProductMappings(storeId: string, selectedAccountIds: string[]) {
    if (selectedAccountIds.length === 0) return Promise.resolve([]);

    return prisma.adProductMapping.findMany({
      where: {
        validUntil: null,
        ad: {
          adAccount: { storeId, metaAccountId: { in: selectedAccountIds } },
        },
        product: { storeId, deletedAt: null },
      },
      select: {
        metaAdId: true,
        productId: true,
        variantId: true,
        confidence: true,
        source: true,
        isMerchantConfirmed: true,
        product: {
          select: { id: true, shopifyProductId: true, title: true },
        },
      },
    });
  }

  getSharedExposureTargets(
    storeId: string,
    selectedAccountIds: string[],
    adIds: string[],
  ) {
    const uniqueAdIds = [...new Set(adIds)];
    if (uniqueAdIds.length === 0 || selectedAccountIds.length === 0) return Promise.resolve([]);

    return prisma.metaAd.findMany({
      where: {
        id: { in: uniqueAdIds },
        deletedAt: null,
        targetScope: { in: ['MULTI_PRODUCT', 'COLLECTION'] },
        adAccount: { storeId, metaAccountId: { in: selectedAccountIds } },
      },
      select: {
        id: true,
        metaAdId: true,
        name: true,
        targetScope: true,
        targetScopeConfidence: true,
        adAccount: { select: { currency: true } },
        productMappings: {
          where: { validUntil: null },
          select: {
            productId: true,
            confidence: true,
            isMerchantConfirmed: true,
            product: {
              select: {
                id: true,
                shopifyProductId: true,
                title: true,
                deletedAt: true,
              },
            },
          },
        },
        collectionMappings: {
          where: { validUntil: null, collection: { deletedAt: null } },
          select: {
            confidence: true,
            isMerchantConfirmed: true,
            collection: {
              select: {
                id: true,
                shopifyCollectionId: true,
                title: true,
                handle: true,
                deletedAt: true,
                _count: { select: { products: true } },
                products: {
                  where: { product: { deletedAt: null } },
                  take: SHARED_COLLECTION_MEMBER_LIMIT,
                  orderBy: [{ position: 'asc' }, { productId: 'asc' }],
                  select: {
                    product: {
                      select: {
                        id: true,
                        shopifyProductId: true,
                        title: true,
                        deletedAt: true,
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
      orderBy: [{ metaUpdatedAt: 'desc' }, { name: 'asc' }],
    });
  }

  getInventoryLevels(storeId: string) {
    return prisma.inventoryLevelCurrent.findMany({
      where: {
        inventoryItem: {
          storeId,
          deletedAt: null,
          variant: { deletedAt: null, product: { deletedAt: null } },
        },
        location: { deletedAt: null, isActive: true },
      },
      select: {
        available: true,
        incoming: true,
        inventoryItem: {
          select: {
            variant: {
              select: { id: true, productId: true },
            },
          },
        },
      },
    });
  }

  getSettings(storeId: string) {
    return prisma.store.findUnique({
      where: { id: storeId },
      select: {
        inventoryIntelligenceMode: true,
        inventoryReviewedAt: true,
      },
    });
  }

  updateInventoryMode(storeId: string, inventoryIntelligenceMode: 'DISABLED' | 'TRUSTED' | 'UNRELIABLE') {
    return prisma.store.update({
      where: { id: storeId },
      data: {
        inventoryIntelligenceMode,
        inventoryReviewedAt: new Date(),
      },
      select: {
        inventoryIntelligenceMode: true,
        inventoryReviewedAt: true,
      },
    });
  }
}
