import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { metricChanges } from './analytics.metrics.js';
import { pagination, windowResponse } from './analytics.shared.js';
import type { AnalyticsWindows } from './analytics.shared.js';

type CollectionPeriod = 'CURRENT' | 'COMPARISON';

type RawCollectionMetricRow = {
  total_count: bigint;
  collection_id: string | null;
  shopify_collection_id: string | null;
  title: string | null;
  handle: string | null;
  image_url: string | null;
  product_count: bigint | number | null;
  period: CollectionPeriod | null;
  order_count: bigint | number | null;
  sold_units: bigint | number | null;
  refunded_units: bigint | number | null;
  product_revenue: Prisma.Decimal | string | number | null;
  refunds: Prisma.Decimal | string | number | null;
};

type CollectionMetrics = {
  orderCount: number;
  soldUnits: number;
  refundedUnits: number;
  netUnits: number;
  productRevenue: number;
  refunds: number;
  netProductRevenue: number;
};

function numeric(value: Prisma.Decimal | string | number | bigint | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function metrics(row: RawCollectionMetricRow | undefined): CollectionMetrics {
  const soldUnits = numeric(row?.sold_units ?? null);
  const refundedUnits = numeric(row?.refunded_units ?? null);
  const productRevenue = numeric(row?.product_revenue ?? null);
  const refunds = numeric(row?.refunds ?? null);
  return {
    orderCount: numeric(row?.order_count ?? null),
    soldUnits,
    refundedUnits,
    netUnits: Math.max(0, soldUnits - refundedUnits),
    productRevenue,
    refunds,
    netProductRevenue: Math.max(0, productRevenue - refunds),
  };
}

/**
 * Collection list analytics using current collection membership applied to historical order cohorts.
 * The database pages collections before joining membership/order facts, so response work is bounded
 * by the requested collection page rather than by the merchant's complete membership graph.
 */
export class CollectionAnalyticsReadService {
  async list(input: {
    storeId: string;
    currency: string;
    windows: AnalyticsWindows;
    page: number;
    limit: number;
  }) {
    const offset = (input.page - 1) * input.limit;
    const rows = await prisma.$queryRaw<RawCollectionMetricRow[]>(Prisma.sql`
      WITH all_collections AS (
        SELECT
          c."id",
          c."shopifyCollectionId",
          c."title",
          c."handle",
          c."imageUrl",
          COUNT(membership."productId") AS product_count
        FROM "Collection" c
        LEFT JOIN "ProductCollection" membership ON membership."collectionId" = c."id"
        WHERE c."storeId" = ${input.storeId}::uuid
          AND c."deletedAt" IS NULL
        GROUP BY c."id"
      ),
      page_collections AS MATERIALIZED (
        SELECT *
        FROM all_collections
        ORDER BY "title" ASC, "id" ASC
        OFFSET ${offset}
        LIMIT ${input.limit}
      ),
      scoped_lines AS (
        SELECT
          page."id" AS collection_id,
          line."id" AS line_id,
          line."orderId" AS order_id,
          line."quantity",
          COALESCE(line."discountedTotal", 0) AS product_revenue,
          CASE
            WHEN (
              orders."processedAt" BETWEEN ${input.windows.current.instantFrom} AND ${input.windows.current.instantTo}
              OR (
                orders."processedAt" IS NULL
                AND orders."shopifyCreatedAt" BETWEEN ${input.windows.current.instantFrom} AND ${input.windows.current.instantTo}
              )
            ) THEN 'CURRENT'
            ELSE 'COMPARISON'
          END AS period
        FROM page_collections page
        INNER JOIN "ProductCollection" membership ON membership."collectionId" = page."id"
        INNER JOIN "OrderLineItem" line ON line."productId" = membership."productId"
        INNER JOIN "Order" orders ON orders."id" = line."orderId"
        WHERE orders."storeId" = ${input.storeId}::uuid
          AND orders."isTest" = FALSE
          AND orders."cancelledAt" IS NULL
          AND orders."currencyCode" = ${input.currency}
          AND (
            orders."processedAt" BETWEEN ${input.windows.current.instantFrom} AND ${input.windows.current.instantTo}
            OR (
              orders."processedAt" IS NULL
              AND orders."shopifyCreatedAt" BETWEEN ${input.windows.current.instantFrom} AND ${input.windows.current.instantTo}
            )
            OR orders."processedAt" BETWEEN ${input.windows.comparison.instantFrom} AND ${input.windows.comparison.instantTo}
            OR (
              orders."processedAt" IS NULL
              AND orders."shopifyCreatedAt" BETWEEN ${input.windows.comparison.instantFrom} AND ${input.windows.comparison.instantTo}
            )
          )
      ),
      refund_totals AS (
        SELECT
          refund_line."orderLineItemId" AS line_id,
          COALESCE(SUM(refund_line."quantity"), 0) AS refunded_units,
          COALESCE(SUM(refund_line."subtotal"), 0) AS refunds
        FROM "RefundLineItem" refund_line
        INNER JOIN (SELECT DISTINCT line_id FROM scoped_lines) scoped ON scoped.line_id = refund_line."orderLineItemId"
        GROUP BY refund_line."orderLineItemId"
      ),
      aggregates AS (
        SELECT
          scoped.collection_id,
          scoped.period,
          COUNT(DISTINCT scoped.order_id) AS order_count,
          COALESCE(SUM(scoped."quantity"), 0) AS sold_units,
          COALESCE(SUM(refunds.refunded_units), 0) AS refunded_units,
          COALESCE(SUM(scoped.product_revenue), 0) AS product_revenue,
          COALESCE(SUM(refunds.refunds), 0) AS refunds
        FROM scoped_lines scoped
        LEFT JOIN refund_totals refunds ON refunds.line_id = scoped.line_id
        GROUP BY scoped.collection_id, scoped.period
      ),
      periods(period) AS (VALUES ('CURRENT'::text), ('COMPARISON'::text)),
      page_metrics AS (
        SELECT
          page."id" AS collection_id,
          page."shopifyCollectionId" AS shopify_collection_id,
          page."title",
          page."handle",
          page."imageUrl" AS image_url,
          page.product_count,
          periods.period,
          COALESCE(aggregate.order_count, 0) AS order_count,
          COALESCE(aggregate.sold_units, 0) AS sold_units,
          COALESCE(aggregate.refunded_units, 0) AS refunded_units,
          COALESCE(aggregate.product_revenue, 0) AS product_revenue,
          COALESCE(aggregate.refunds, 0) AS refunds
        FROM page_collections page
        CROSS JOIN periods
        LEFT JOIN aggregates aggregate
          ON aggregate.collection_id = page."id"
          AND aggregate.period = periods.period
      )
      SELECT
        (SELECT COUNT(*) FROM all_collections) AS total_count,
        metrics.collection_id,
        metrics.shopify_collection_id,
        metrics.title,
        metrics.handle,
        metrics.image_url,
        metrics.product_count,
        metrics.period,
        metrics.order_count,
        metrics.sold_units,
        metrics.refunded_units,
        metrics.product_revenue,
        metrics.refunds
      FROM (SELECT 1) anchor
      LEFT JOIN page_metrics metrics ON TRUE
      ORDER BY metrics.title ASC NULLS LAST, metrics.collection_id ASC NULLS LAST, metrics.period ASC NULLS LAST
    `);

    const total = numeric(rows[0]?.total_count ?? null);
    const groups = new Map<
      string,
      {
        collection: {
          id: string;
          shopifyCollectionId: string;
          title: string;
          handle: string | null;
          imageUrl: string | null;
          productCount: number;
        };
        current?: RawCollectionMetricRow;
        comparison?: RawCollectionMetricRow;
      }
    >();

    for (const row of rows) {
      if (!row.collection_id || !row.shopify_collection_id || !row.title || !row.period) continue;
      const group = groups.get(row.collection_id) ?? {
        collection: {
          id: row.collection_id,
          shopifyCollectionId: row.shopify_collection_id,
          title: row.title,
          handle: row.handle,
          imageUrl: row.image_url,
          productCount: numeric(row.product_count),
        },
      };
      if (row.period === 'CURRENT') group.current = row;
      else group.comparison = row;
      groups.set(row.collection_id, group);
    }

    return {
      window: windowResponse(input.windows),
      currency: input.currency,
      methodology: 'SHOPIFY_ORDER_COHORT_WITH_CURRENT_COLLECTION_MEMBERSHIP',
      membershipSnapshot: 'CURRENT' as const,
      pagination: pagination(input.page, input.limit, total),
      items: [...groups.values()].map((group) => {
        const current = metrics(group.current);
        const comparison = metrics(group.comparison);
        return {
          collection: group.collection,
          current,
          comparison,
          change: metricChanges(current, comparison),
        };
      }),
    };
  }
}

export const collectionAnalyticsReadService = new CollectionAnalyticsReadService();
