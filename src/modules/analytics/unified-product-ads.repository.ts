import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import type {
  UnifiedAdvertisingAccountRow,
  UnifiedAdvertisingPeriod,
  UnifiedAdvertisingProvider,
} from '../advertising/unified-advertising.repository.js';

export interface UnifiedProductMappingRow {
  id: string;
  adId: string;
  productId: string;
  variantId: string | null;
  granularity: string;
  source: string;
  confidence: number;
  evidence: unknown;
  landingUrl: string | null;
  providerProductId: string | null;
  providerProductGroupId: string | null;
  merchantConfirmed: boolean;
  validFrom: Date;
  validUntil: Date | null;
  ad: {
    id: string;
    providerEntityId: string;
    name: string;
    targetScope: string;
    targetScopeConfidence: number | null;
    targetScopeEvidence: unknown;
    account: {
      id: string;
      provider: UnifiedAdvertisingProvider;
      providerEntityId: string;
      name: string;
      currency: string | null;
    };
    campaign: { id: string; providerEntityId: string; name: string };
    group: { id: string; providerEntityId: string; kind: string; name: string } | null;
  };
  product: {
    id: string;
    shopifyProductId: string;
    title: string;
    status: string;
    deletedAt: Date | null;
  };
  variant: {
    id: string;
    shopifyVariantId: string;
    title: string;
    sku: string | null;
  } | null;
  collectionMappingCount: number;
}

export interface UnifiedProductAdMetricRow {
  period: UnifiedAdvertisingPeriod;
  adId: string;
  accountId: string;
  currency: string | null;
  sourceRows: number;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number | null;
  conversionValue: number | null;
}

export type UnifiedMappingClassification = 'EXACT' | 'SHARED' | 'AMBIGUOUS';

export interface UnifiedMappingResolutionRow {
  adId: string;
  classification: UnifiedMappingClassification;
  productId: string | null;
  confidence: number;
  merchantConfirmed: boolean;
}

export interface UnifiedMappingAccountingRow {
  period: UnifiedAdvertisingPeriod;
  classification: UnifiedMappingClassification;
  provider: UnifiedAdvertisingProvider;
  spend: number;
}

type RawCandidateRow = { product_id: string; total_count: bigint };
type RawResolutionRow = {
  ad_id: string;
  classification: UnifiedMappingClassification;
  product_id: string | null;
  confidence: Prisma.Decimal | string | number | null;
  merchant_confirmed: boolean;
};
type RawAccountingRow = {
  period: UnifiedAdvertisingPeriod;
  classification: UnifiedMappingClassification;
  provider: UnifiedAdvertisingProvider;
  spend: Prisma.Decimal | string | number | null;
};

function decimal(value: Prisma.Decimal | string | number | null | undefined): number | null {
  if (value == null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function integer(value: bigint | number | null | undefined): number {
  if (value == null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function uuidList(ids: string[]) {
  return Prisma.join(ids.map((id) => Prisma.sql`${id}::uuid`));
}

function mappingClassificationCtes(input: { storeId: string; accountIds: string[] }) {
  const accountScope =
    input.accountIds.length > 0
      ? Prisma.sql`ad."accountId" IN (${uuidList(input.accountIds)})`
      : Prisma.sql`FALSE`;
  return Prisma.sql`
    active_mapping AS (
      SELECT
        mapping."adId" AS ad_id,
        mapping."productId" AS product_id,
        mapping."confidence" AS confidence,
        mapping."isMerchantConfirmed" AS merchant_confirmed,
        ad."targetScope"::text AS target_scope,
        account."provider"::text AS provider,
        EXISTS (
          SELECT 1
          FROM "AdvertisingCollectionMapping" collection_mapping
          WHERE collection_mapping."adId" = mapping."adId"
            AND collection_mapping."validUntil" IS NULL
        ) AS has_collection_mapping
      FROM "AdvertisingProductMapping" mapping
      INNER JOIN "AdvertisingAd" ad ON ad."id" = mapping."adId"
      INNER JOIN "AdvertisingAccount" account ON account."id" = ad."accountId"
      INNER JOIN "Product" product ON product."id" = mapping."productId"
      WHERE mapping."validUntil" IS NULL
        AND ad."deletedAt" IS NULL
        AND ${accountScope}
        AND account."storeId" = ${input.storeId}::uuid
        AND product."storeId" = ${input.storeId}::uuid
    ),
    mapping_classification AS (
      SELECT
        active.ad_id,
        MIN(active.provider) AS provider,
        CASE
          WHEN BOOL_OR(active.target_scope IN ('MULTI_PRODUCT', 'COLLECTION') OR active.has_collection_mapping)
            THEN 'SHARED'
          WHEN COUNT(*) FILTER (WHERE active.merchant_confirmed) > 0
            AND COUNT(DISTINCT active.product_id) FILTER (WHERE active.merchant_confirmed) = 1
            THEN 'EXACT'
          WHEN COUNT(*) FILTER (WHERE active.merchant_confirmed) > 0
            THEN 'AMBIGUOUS'
          WHEN COUNT(*) FILTER (WHERE active.confidence >= 0.7) > 0
            AND COUNT(DISTINCT active.product_id) FILTER (WHERE active.confidence >= 0.7) = 1
            THEN 'EXACT'
          ELSE 'AMBIGUOUS'
        END AS classification,
        CASE
          WHEN BOOL_OR(active.target_scope IN ('MULTI_PRODUCT', 'COLLECTION') OR active.has_collection_mapping)
            THEN NULL::uuid
          WHEN COUNT(*) FILTER (WHERE active.merchant_confirmed) > 0
            AND COUNT(DISTINCT active.product_id) FILTER (WHERE active.merchant_confirmed) = 1
            THEN (MIN(active.product_id::text) FILTER (WHERE active.merchant_confirmed))::uuid
          WHEN COUNT(*) FILTER (WHERE active.merchant_confirmed) = 0
            AND COUNT(*) FILTER (WHERE active.confidence >= 0.7) > 0
            AND COUNT(DISTINCT active.product_id) FILTER (WHERE active.confidence >= 0.7) = 1
            THEN (MIN(active.product_id::text) FILTER (WHERE active.confidence >= 0.7))::uuid
          ELSE NULL::uuid
        END AS exact_product_id,
        CASE
          WHEN BOOL_OR(active.target_scope IN ('MULTI_PRODUCT', 'COLLECTION') OR active.has_collection_mapping)
            THEN MAX(active.confidence)
          WHEN COUNT(*) FILTER (WHERE active.merchant_confirmed) > 0
            AND COUNT(DISTINCT active.product_id) FILTER (WHERE active.merchant_confirmed) = 1
            THEN 1::numeric
          WHEN COUNT(*) FILTER (WHERE active.merchant_confirmed) > 0
            THEN MAX(active.confidence) FILTER (WHERE active.merchant_confirmed)
          ELSE COALESCE(MAX(active.confidence) FILTER (WHERE active.confidence >= 0.7), 0)
        END AS confidence,
        BOOL_OR(active.merchant_confirmed) AS merchant_confirmed
      FROM active_mapping active
      GROUP BY active.ad_id
    )
  `;
}

export class UnifiedProductAdsRepository {
  async rankedProductCandidates(input: {
    storeId: string;
    accountIds: string[];
    currency: string;
    currentFrom: Date;
    currentTo: Date;
    comparisonFrom: Date;
    comparisonTo: Date;
    metricCurrentFrom: Date;
    metricCurrentTo: Date;
    metricComparisonFrom: Date;
    metricComparisonTo: Date;
    historyComplete: boolean;
    page: number;
    limit: number;
    productId?: string;
  }): Promise<{ productIds: string[]; total: number }> {
    const offset = input.productId ? 0 : (input.page - 1) * input.limit;
    const limit = input.productId ? 1 : input.limit;
    const productFilter = input.productId
      ? Prisma.sql`AND candidate.product_id = ${input.productId}::uuid`
      : Prisma.empty;
    const explicitProductCandidate = input.productId
      ? Prisma.sql`
          UNION
          SELECT product."id" AS product_id
          FROM "Product" product
          WHERE product."id" = ${input.productId}::uuid
            AND product."storeId" = ${input.storeId}::uuid
            AND product."deletedAt" IS NULL
        `
      : Prisma.empty;
    const adMetricScope =
      input.accountIds.length > 0
        ? Prisma.sql`metric."accountId" IN (${uuidList(input.accountIds)})`
        : Prisma.sql`FALSE`;

    const rows = await prisma.$queryRaw<RawCandidateRow[]>(Prisma.sql`
      WITH
      ${mappingClassificationCtes(input)},
      commerce_products AS (
        SELECT DISTINCT line_item."productId" AS product_id
        FROM "OrderLineItem" line_item
        INNER JOIN "Order" orders ON orders."id" = line_item."orderId"
        WHERE line_item."productId" IS NOT NULL
          AND orders."storeId" = ${input.storeId}::uuid
          AND orders."isTest" = FALSE
          AND orders."cancelledAt" IS NULL
          AND orders."currencyCode" = ${input.currency}
          AND (
            COALESCE(orders."processedAt", orders."shopifyCreatedAt") BETWEEN ${input.currentFrom} AND ${input.currentTo}
            OR COALESCE(orders."processedAt", orders."shopifyCreatedAt") BETWEEN ${input.comparisonFrom} AND ${input.comparisonTo}
          )
      ),
      current_lines AS (
        SELECT
          line_item."id",
          line_item."productId" AS product_id,
          COALESCE(line_item."discountedTotal", 0) AS revenue
        FROM "OrderLineItem" line_item
        INNER JOIN "Order" orders ON orders."id" = line_item."orderId"
        WHERE line_item."productId" IS NOT NULL
          AND orders."storeId" = ${input.storeId}::uuid
          AND orders."isTest" = FALSE
          AND orders."cancelledAt" IS NULL
          AND orders."currencyCode" = ${input.currency}
          AND COALESCE(orders."processedAt", orders."shopifyCreatedAt") BETWEEN ${input.currentFrom} AND ${input.currentTo}
      ),
      current_refunds AS (
        SELECT
          refund_line."orderLineItemId" AS line_item_id,
          COALESCE(SUM(refund_line."subtotal"), 0) AS refunds
        FROM "RefundLineItem" refund_line
        INNER JOIN current_lines current_line ON current_line."id" = refund_line."orderLineItemId"
        GROUP BY refund_line."orderLineItemId"
      ),
      current_commerce AS (
        SELECT
          current_line.product_id,
          GREATEST(
            COALESCE(SUM(current_line.revenue), 0) - COALESCE(SUM(current_refunds.refunds), 0),
            0
          ) AS net_revenue
        FROM current_lines current_line
        LEFT JOIN current_refunds ON current_refunds.line_item_id = current_line."id"
        GROUP BY current_line.product_id
      ),
      mapped_products AS (
        SELECT DISTINCT product_id FROM active_mapping
      ),
      candidate_ids AS (
        SELECT product_id FROM commerce_products
        UNION
        SELECT product_id FROM mapped_products
        ${explicitProductCandidate}
      ),
      current_ad_spend AS (
        SELECT metric."adId" AS ad_id, COALESCE(SUM(metric."spend"), 0) AS spend
        FROM "AdvertisingDailyMetric" metric
        WHERE ${adMetricScope}
          AND metric."level" = 'AD'::"AdvertisingMetricLevel"
          AND metric."adId" IS NOT NULL
          AND metric."currency" = ${input.currency}
          AND metric."date" BETWEEN ${input.metricCurrentFrom}::date AND ${input.metricCurrentTo}::date
        GROUP BY metric."adId"
      ),
      exact_product_spend AS (
        SELECT classification.exact_product_id AS product_id, SUM(ad_spend.spend) AS spend
        FROM mapping_classification classification
        INNER JOIN current_ad_spend ad_spend ON ad_spend.ad_id = classification.ad_id
        WHERE classification.classification = 'EXACT'
          AND classification.exact_product_id IS NOT NULL
        GROUP BY classification.exact_product_id
      ),
      candidate AS (
        SELECT
          product."id" AS product_id,
          exact_spend.spend,
          CASE
            WHEN current_commerce.product_id IS NULL AND ${input.historyComplete}
              THEN 0::numeric
            ELSE current_commerce.net_revenue
          END AS net_revenue,
          product."title"
        FROM candidate_ids ids
        INNER JOIN "Product" product
          ON product."id" = ids.product_id
          AND product."storeId" = ${input.storeId}::uuid
          AND product."deletedAt" IS NULL
        LEFT JOIN exact_product_spend exact_spend ON exact_spend.product_id = product."id"
        LEFT JOIN current_commerce ON current_commerce.product_id = product."id"
      )
      SELECT candidate.product_id, COUNT(*) OVER() AS total_count
      FROM candidate
      WHERE TRUE ${productFilter}
      ORDER BY candidate.spend DESC NULLS LAST, candidate.net_revenue DESC NULLS LAST, candidate.title ASC, candidate.product_id ASC
      LIMIT ${limit} OFFSET ${offset}
    `);

    return {
      productIds: rows.map((row) => row.product_id),
      total: rows.length > 0 ? integer(rows[0]!.total_count) : 0,
    };
  }

  async mappingAccountingRows(input: {
    storeId: string;
    accounts: UnifiedAdvertisingAccountRow[];
    currency: string;
    currentFrom: Date;
    currentTo: Date;
    comparisonFrom: Date;
    comparisonTo: Date;
  }): Promise<UnifiedMappingAccountingRow[]> {
    const accountIds = input.accounts.map((account) => account.id);
    if (accountIds.length === 0) return [];
    const rows = await prisma.$queryRaw<RawAccountingRow[]>(Prisma.sql`
      WITH
      ${mappingClassificationCtes({ storeId: input.storeId, accountIds })},
      metric_rows AS (
        SELECT
          CASE
            WHEN metric."date" BETWEEN ${input.currentFrom}::date AND ${input.currentTo}::date
              THEN 'CURRENT'
            ELSE 'COMPARISON'
          END AS period,
          metric."adId" AS ad_id,
          metric."accountId" AS account_id,
          metric."spend" AS spend
        FROM "AdvertisingDailyMetric" metric
        WHERE metric."accountId" IN (${uuidList(accountIds)})
          AND metric."level" = 'AD'::"AdvertisingMetricLevel"
          AND metric."adId" IS NOT NULL
          AND metric."currency" = ${input.currency}
          AND (
            metric."date" BETWEEN ${input.currentFrom}::date AND ${input.currentTo}::date
            OR metric."date" BETWEEN ${input.comparisonFrom}::date AND ${input.comparisonTo}::date
          )
      )
      SELECT
        metric.period,
        classification.classification,
        account."provider"::text AS provider,
        COALESCE(SUM(metric.spend), 0) AS spend
      FROM metric_rows metric
      INNER JOIN mapping_classification classification ON classification.ad_id = metric.ad_id
      INNER JOIN "AdvertisingAccount" account ON account."id" = metric.account_id
      GROUP BY metric.period, classification.classification, account."provider"
      ORDER BY metric.period, classification.classification, account."provider"
    `);
    return rows.map((row) => ({
      period: row.period,
      classification: row.classification,
      provider: row.provider,
      spend: decimal(row.spend) ?? 0,
    }));
  }

  async mappingResolutionsForProducts(
    storeId: string,
    accountIds: string[],
    productIds: string[],
  ): Promise<UnifiedMappingResolutionRow[]> {
    if (accountIds.length === 0 || productIds.length === 0) return [];
    const rows = await prisma.$queryRaw<RawResolutionRow[]>(Prisma.sql`
      WITH
      ${mappingClassificationCtes({ storeId, accountIds })},
      selected_ads AS (
        SELECT DISTINCT active.ad_id
        FROM active_mapping active
        WHERE active.product_id IN (${uuidList(productIds)})
      )
      SELECT
        classification.ad_id,
        classification.classification,
        classification.exact_product_id AS product_id,
        classification.confidence,
        classification.merchant_confirmed
      FROM mapping_classification classification
      INNER JOIN selected_ads selected ON selected.ad_id = classification.ad_id
      ORDER BY classification.ad_id
    `);
    return rows.map((row) => ({
      adId: row.ad_id,
      classification: row.classification,
      productId: row.product_id,
      confidence: decimal(row.confidence) ?? 0,
      merchantConfirmed: row.merchant_confirmed,
    }));
  }

  async activeMappings(
    storeId: string,
    accountIds: string[],
    productIds: string[],
  ): Promise<UnifiedProductMappingRow[]> {
    if (accountIds.length === 0 || productIds.length === 0) return [];
    const rows = await prisma.advertisingProductMapping.findMany({
      where: {
        validUntil: null,
        productId: { in: productIds },
        ad: {
          accountId: { in: accountIds },
          deletedAt: null,
          account: { storeId },
        },
        product: { storeId },
      },
      select: {
        id: true,
        adId: true,
        productId: true,
        variantId: true,
        granularity: true,
        source: true,
        confidence: true,
        evidenceJson: true,
        landingUrl: true,
        providerProductId: true,
        providerProductGroupId: true,
        isMerchantConfirmed: true,
        validFrom: true,
        validUntil: true,
        ad: {
          select: {
            id: true,
            providerEntityId: true,
            name: true,
            targetScope: true,
            targetScopeConfidence: true,
            targetScopeEvidence: true,
            account: {
              select: {
                id: true,
                provider: true,
                providerEntityId: true,
                name: true,
                currency: true,
              },
            },
            campaign: { select: { id: true, providerEntityId: true, name: true } },
            group: {
              select: { id: true, providerEntityId: true, kind: true, name: true },
            },
            _count: {
              select: { collectionMappings: { where: { validUntil: null } } },
            },
          },
        },
        product: {
          select: {
            id: true,
            shopifyProductId: true,
            title: true,
            status: true,
            deletedAt: true,
          },
        },
        variant: {
          select: {
            id: true,
            shopifyVariantId: true,
            title: true,
            sku: true,
          },
        },
      },
      orderBy: [{ adId: 'asc' }, { productId: 'asc' }, { variantId: 'asc' }],
    });
    return rows.map((row) => ({
      id: row.id,
      adId: row.adId,
      productId: row.productId,
      variantId: row.variantId,
      granularity: row.granularity,
      source: row.source,
      confidence: Number(row.confidence),
      evidence: row.evidenceJson,
      landingUrl: row.landingUrl,
      providerProductId: row.providerProductId,
      providerProductGroupId: row.providerProductGroupId,
      merchantConfirmed: row.isMerchantConfirmed,
      validFrom: row.validFrom,
      validUntil: row.validUntil,
      ad: {
        id: row.ad.id,
        providerEntityId: row.ad.providerEntityId,
        name: row.ad.name,
        targetScope: row.ad.targetScope,
        targetScopeConfidence:
          row.ad.targetScopeConfidence == null ? null : Number(row.ad.targetScopeConfidence),
        targetScopeEvidence: row.ad.targetScopeEvidence,
        account: row.ad.account as UnifiedProductMappingRow['ad']['account'],
        campaign: row.ad.campaign,
        group: row.ad.group,
      },
      product: row.product,
      variant: row.variant,
      collectionMappingCount: row.ad._count.collectionMappings,
    }));
  }

  async adMetricRows(input: {
    accounts: UnifiedAdvertisingAccountRow[];
    adIds: string[];
    currentFrom: Date;
    currentTo: Date;
    comparisonFrom: Date;
    comparisonTo: Date;
  }): Promise<UnifiedProductAdMetricRow[]> {
    const accountIds = input.accounts.map((account) => account.id);
    if (accountIds.length === 0 || input.adIds.length === 0) return [];
    const periods = [
      { period: 'CURRENT' as const, from: input.currentFrom, to: input.currentTo },
      { period: 'COMPARISON' as const, from: input.comparisonFrom, to: input.comparisonTo },
    ];
    const values = await Promise.all(
      periods.map(async ({ period, from, to }) => {
        const rows = await prisma.advertisingDailyMetric.groupBy({
          by: ['adId', 'accountId', 'currency'],
          where: {
            accountId: { in: accountIds },
            level: 'AD',
            adId: { in: input.adIds },
            date: { gte: from, lte: to },
          },
          _count: { _all: true, conversions: true, conversionValue: true },
          _sum: {
            spend: true,
            impressions: true,
            clicks: true,
            conversions: true,
            conversionValue: true,
          },
        });
        const incompleteConversionCurrencies = new Set(
          rows
            .filter((row) => row._count.conversions !== row._count._all)
            .map((row) => row.currency),
        );
        const incompleteValueCurrencies = new Set(
          rows
            .filter((row) => row._count.conversionValue !== row._count._all)
            .map((row) => row.currency),
        );
        return rows.flatMap((row) =>
          row.adId
            ? [{
                period,
                adId: row.adId,
                accountId: row.accountId,
                currency: row.currency,
                sourceRows: row._count._all,
                spend: decimal(row._sum.spend) ?? 0,
                impressions: integer(row._sum.impressions),
                clicks: integer(row._sum.clicks),
                conversions: incompleteConversionCurrencies.has(row.currency)
                  ? null
                  : decimal(row._sum.conversions),
                conversionValue: incompleteValueCurrencies.has(row.currency)
                  ? null
                  : decimal(row._sum.conversionValue),
              }]
            : [],
        );
      }),
    );
    return values.flat();
  }

  async productIdentities(storeId: string, productIds: string[]) {
    const ids = [...new Set(productIds)];
    if (ids.length === 0) return [];
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
}
