import { Prisma } from '../../generated/prisma/client.js';
import { AppError } from '../../errors/app-error.js';
import { prisma } from '../../lib/prisma.js';
import { resolveAnalyticsWindows } from './analytics.dates.js';
import { metricChanges } from './analytics.metrics.js';
import type { AnalyticsRangeQuery } from './analytics.schema.js';
import { windowResponse } from './analytics.shared.js';

type RawPeriodRow = {
  period: 'CURRENT' | 'COMPARISON';
  order_count: bigint | number | null;
  sold_units: bigint | number | null;
  refunded_units: bigint | number | null;
  product_revenue: Prisma.Decimal | string | number | null;
  refunds: Prisma.Decimal | string | number | null;
};

type RawDailyRow = {
  bucket_date: Date;
  order_count: bigint | number | null;
  sold_units: bigint | number | null;
  refunded_units: bigint | number | null;
  product_revenue: Prisma.Decimal | string | number | null;
  refunds: Prisma.Decimal | string | number | null;
};

type RawTopProductRow = {
  product_id: string;
  product_title: string;
  order_count: bigint | number | null;
  net_units: bigint | number | null;
  net_revenue: Prisma.Decimal | string | number | null;
};

function numeric(value: Prisma.Decimal | string | number | bigint | null | undefined) {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function metrics(row?: RawPeriodRow) {
  const soldUnits = numeric(row?.sold_units);
  const refundedUnits = numeric(row?.refunded_units);
  const productRevenue = numeric(row?.product_revenue);
  const refunds = numeric(row?.refunds);
  return {
    orderCount: numeric(row?.order_count),
    soldUnits,
    refundedUnits,
    netUnits: Math.max(0, soldUnits - refundedUnits),
    productRevenue,
    refunds,
    netProductRevenue: Math.max(0, productRevenue - refunds),
  };
}

export class CollectionPerformanceReadService {
  async read(storeId: string, collectionId: string, query: AnalyticsRangeQuery, now = new Date()) {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, ianaTimezone: true, currencyCode: true },
    });
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    const collection = await prisma.collection.findFirst({
      where: { id: collectionId, storeId, deletedAt: null },
      select: { id: true, title: true },
    });
    if (!collection) throw new AppError('Collection not found', 404, 'COLLECTION_NOT_FOUND');

    const windows = resolveAnalyticsWindows(query, store.ianaTimezone, now);
    const [periodRows, dailyRows, topRows] = await Promise.all([
      prisma.$queryRaw<RawPeriodRow[]>(Prisma.sql`
        WITH membership AS MATERIALIZED (
          SELECT "productId" FROM "ProductCollection" WHERE "collectionId" = ${collectionId}::uuid
        ), scoped AS MATERIALIZED (
          SELECT
            line."id" AS line_id,
            line."orderId" AS order_id,
            line."quantity",
            COALESCE(line."discountedTotal", 0) AS product_revenue,
            CASE
              WHEN COALESCE(o."processedAt", o."shopifyCreatedAt") BETWEEN ${windows.current.instantFrom} AND ${windows.current.instantTo}
                THEN 'CURRENT'
              ELSE 'COMPARISON'
            END AS period
          FROM membership m
          INNER JOIN "OrderLineItem" line ON line."productId" = m."productId"
          INNER JOIN "Order" o ON o."id" = line."orderId"
          WHERE o."storeId" = ${storeId}::uuid
            AND o."isTest" = FALSE
            AND o."cancelledAt" IS NULL
            AND o."currencyCode" = ${store.currencyCode}
            AND (
              COALESCE(o."processedAt", o."shopifyCreatedAt") BETWEEN ${windows.current.instantFrom} AND ${windows.current.instantTo}
              OR COALESCE(o."processedAt", o."shopifyCreatedAt") BETWEEN ${windows.comparison.instantFrom} AND ${windows.comparison.instantTo}
            )
        ), refunds AS (
          SELECT
            r."orderLineItemId" AS line_id,
            COALESCE(SUM(r."quantity"), 0) AS refunded_units,
            COALESCE(SUM(r."subtotal"), 0) AS refunds
          FROM "RefundLineItem" r
          INNER JOIN scoped ON scoped.line_id = r."orderLineItemId"
          GROUP BY r."orderLineItemId"
        )
        SELECT
          scoped.period,
          COUNT(DISTINCT scoped.order_id) AS order_count,
          COALESCE(SUM(scoped."quantity"), 0) AS sold_units,
          COALESCE(SUM(refunds.refunded_units), 0) AS refunded_units,
          COALESCE(SUM(scoped.product_revenue), 0) AS product_revenue,
          COALESCE(SUM(refunds.refunds), 0) AS refunds
        FROM scoped
        LEFT JOIN refunds ON refunds.line_id = scoped.line_id
        GROUP BY scoped.period
      `),
      prisma.$queryRaw<RawDailyRow[]>(Prisma.sql`
        WITH membership AS MATERIALIZED (
          SELECT "productId" FROM "ProductCollection" WHERE "collectionId" = ${collectionId}::uuid
        ), scoped AS MATERIALIZED (
          SELECT
            line."id" AS line_id,
            line."orderId" AS order_id,
            line."quantity",
            COALESCE(line."discountedTotal", 0) AS product_revenue,
            (COALESCE(o."processedAt", o."shopifyCreatedAt") AT TIME ZONE ${store.ianaTimezone})::date AS bucket_date
          FROM membership m
          INNER JOIN "OrderLineItem" line ON line."productId" = m."productId"
          INNER JOIN "Order" o ON o."id" = line."orderId"
          WHERE o."storeId" = ${storeId}::uuid
            AND o."isTest" = FALSE
            AND o."cancelledAt" IS NULL
            AND o."currencyCode" = ${store.currencyCode}
            AND COALESCE(o."processedAt", o."shopifyCreatedAt") BETWEEN ${windows.current.instantFrom} AND ${windows.current.instantTo}
        ), refunds AS (
          SELECT
            r."orderLineItemId" AS line_id,
            COALESCE(SUM(r."quantity"), 0) AS refunded_units,
            COALESCE(SUM(r."subtotal"), 0) AS refunds
          FROM "RefundLineItem" r
          INNER JOIN scoped ON scoped.line_id = r."orderLineItemId"
          GROUP BY r."orderLineItemId"
        )
        SELECT
          scoped.bucket_date,
          COUNT(DISTINCT scoped.order_id) AS order_count,
          COALESCE(SUM(scoped."quantity"), 0) AS sold_units,
          COALESCE(SUM(refunds.refunded_units), 0) AS refunded_units,
          COALESCE(SUM(scoped.product_revenue), 0) AS product_revenue,
          COALESCE(SUM(refunds.refunds), 0) AS refunds
        FROM scoped
        LEFT JOIN refunds ON refunds.line_id = scoped.line_id
        GROUP BY scoped.bucket_date
        ORDER BY scoped.bucket_date ASC
      `),
      prisma.$queryRaw<RawTopProductRow[]>(Prisma.sql`
        WITH membership AS MATERIALIZED (
          SELECT "productId" FROM "ProductCollection" WHERE "collectionId" = ${collectionId}::uuid
        ), scoped AS MATERIALIZED (
          SELECT
            line."id" AS line_id,
            line."productId" AS product_id,
            line."orderId" AS order_id,
            line."quantity",
            COALESCE(line."discountedTotal", 0) AS product_revenue
          FROM membership m
          INNER JOIN "OrderLineItem" line ON line."productId" = m."productId"
          INNER JOIN "Order" o ON o."id" = line."orderId"
          WHERE o."storeId" = ${storeId}::uuid
            AND o."isTest" = FALSE
            AND o."cancelledAt" IS NULL
            AND o."currencyCode" = ${store.currencyCode}
            AND COALESCE(o."processedAt", o."shopifyCreatedAt") BETWEEN ${windows.current.instantFrom} AND ${windows.current.instantTo}
        ), refunds AS (
          SELECT
            r."orderLineItemId" AS line_id,
            COALESCE(SUM(r."quantity"), 0) AS refunded_units,
            COALESCE(SUM(r."subtotal"), 0) AS refunds
          FROM "RefundLineItem" r
          INNER JOIN scoped ON scoped.line_id = r."orderLineItemId"
          GROUP BY r."orderLineItemId"
        )
        SELECT
          scoped.product_id,
          p."title" AS product_title,
          COUNT(DISTINCT scoped.order_id) AS order_count,
          GREATEST(COALESCE(SUM(scoped."quantity" - COALESCE(refunds.refunded_units, 0)), 0), 0) AS net_units,
          GREATEST(COALESCE(SUM(scoped.product_revenue - COALESCE(refunds.refunds, 0)), 0), 0) AS net_revenue
        FROM scoped
        INNER JOIN "Product" p ON p."id" = scoped.product_id
        LEFT JOIN refunds ON refunds.line_id = scoped.line_id
        GROUP BY scoped.product_id, p."title"
        ORDER BY net_revenue DESC, net_units DESC, p."title" ASC
        LIMIT 8
      `),
    ]);

    const current = metrics(periodRows.find((row) => row.period === 'CURRENT'));
    const comparison = metrics(periodRows.find((row) => row.period === 'COMPARISON'));
    return {
      window: windowResponse(windows),
      currency: store.currencyCode,
      methodology: 'SHOPIFY_ORDER_COHORT_WITH_CURRENT_COLLECTION_MEMBERSHIP',
      membershipSnapshot: 'CURRENT' as const,
      collection,
      current,
      comparison,
      change: metricChanges(current, comparison),
      daily: dailyRows.map((row) => ({
        date: row.bucket_date.toISOString().slice(0, 10),
        ...metrics({ ...row, period: 'CURRENT' }),
      })),
      topProducts: topRows.map((row) => ({
        product: { id: row.product_id, title: row.product_title },
        orderCount: numeric(row.order_count),
        netUnits: numeric(row.net_units),
        netRevenue: numeric(row.net_revenue),
      })),
    };
  }
}

export const collectionPerformanceReadService = new CollectionPerformanceReadService();
