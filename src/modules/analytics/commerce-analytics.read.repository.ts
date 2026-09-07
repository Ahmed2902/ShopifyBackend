import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';

export type CommerceOrderPeriod = 'CURRENT' | 'COMPARISON';
export type CommerceCustomerSegment = 'NEW' | 'RETURNING' | 'UNKNOWN';

export interface CommerceOrderAggregateRow {
  period: CommerceOrderPeriod;
  segment: CommerceCustomerSegment;
  orders: number;
  units: number;
  orderValue: number;
  refunds: number;
  discounts: number;
}

export interface CommerceProductEconomicsAggregateRow {
  period: CommerceOrderPeriod;
  productId: string;
  orderCount: number;
  soldUnits: number;
  refundedUnits: number;
  productRevenue: number;
  refunds: number;
  rawCogs: number;
  costCoveredUnits: number;
  costRelevantUnits: number;
}

type RawCommerceOrderAggregateRow = {
  period: CommerceOrderPeriod;
  segment: CommerceCustomerSegment;
  orders: bigint;
  units: bigint | number | null;
  order_value: Prisma.Decimal | string | number | null;
  refunds: Prisma.Decimal | string | number | null;
  discounts: Prisma.Decimal | string | number | null;
};

type RawCommerceProductEconomicsAggregateRow = {
  period: CommerceOrderPeriod;
  product_id: string;
  order_count: bigint;
  sold_units: bigint | number | null;
  refunded_units: bigint | number | null;
  product_revenue: Prisma.Decimal | string | number | null;
  refunds: Prisma.Decimal | string | number | null;
  raw_cogs: Prisma.Decimal | string | number | null;
  cost_covered_units: bigint | number | null;
  cost_relevant_units: bigint | number | null;
};

function numeric(value: Prisma.Decimal | string | number | bigint | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

export type CommerceAggregateInput = {
  storeId: string;
  currency: string;
  currentFrom: Date;
  currentTo: Date;
  comparisonFrom: Date;
  comparisonTo: Date;
};

/**
 * High-volume Shopify commerce analytics reads.
 *
 * PostgreSQL performs the broad scan/joins and returns compact aggregate rows instead of
 * materializing complete Order / OrderLineItem / Refund / VariantCost histories in Node.
 */
export class CommerceAnalyticsReadRepository {
  async getOrderAggregates(input: CommerceAggregateInput): Promise<CommerceOrderAggregateRow[]> {
    const rows = await prisma.$queryRaw<RawCommerceOrderAggregateRow[]>(Prisma.sql`
      WITH scoped_orders AS (
        SELECT
          o."id",
          CASE
            WHEN COALESCE(o."processedAt", o."shopifyCreatedAt") BETWEEN ${input.currentFrom} AND ${input.currentTo}
              THEN 'CURRENT'
            ELSE 'COMPARISON'
          END AS period,
          CASE
            WHEN o."customerJourneyReady" IS NOT TRUE OR o."customerOrderIndex" IS NULL
              THEN 'UNKNOWN'
            WHEN o."customerOrderIndex" = 1
              THEN 'NEW'
            WHEN o."customerOrderIndex" > 1
              THEN 'RETURNING'
            ELSE 'UNKNOWN'
          END AS segment,
          COALESCE(o."currentSubtotalLineItemsQuantity", 0) AS units,
          COALESCE(o."currentTotalAmount", 0) AS order_value,
          COALESCE(o."currentTotalDiscountsAmount", 0) AS discounts
        FROM "Order" o
        WHERE o."storeId" = ${input.storeId}::uuid
          AND o."isTest" = FALSE
          AND o."cancelledAt" IS NULL
          AND o."currencyCode" = ${input.currency}
          AND (
            COALESCE(o."processedAt", o."shopifyCreatedAt") BETWEEN ${input.currentFrom} AND ${input.currentTo}
            OR COALESCE(o."processedAt", o."shopifyCreatedAt") BETWEEN ${input.comparisonFrom} AND ${input.comparisonTo}
          )
      ),
      refund_totals AS (
        SELECT
          r."orderId",
          COALESCE(
            SUM(r."totalRefunded") FILTER (
              WHERE r."currencyCode" IS NULL OR r."currencyCode" = ${input.currency}
            ),
            0
          ) AS refunds
        FROM "Refund" r
        INNER JOIN scoped_orders scoped ON scoped."id" = r."orderId"
        GROUP BY r."orderId"
      )
      SELECT
        scoped.period,
        scoped.segment,
        COUNT(*) AS orders,
        COALESCE(SUM(scoped.units), 0) AS units,
        COALESCE(SUM(scoped.order_value), 0) AS order_value,
        COALESCE(SUM(refunds.refunds), 0) AS refunds,
        COALESCE(SUM(scoped.discounts), 0) AS discounts
      FROM scoped_orders scoped
      LEFT JOIN refund_totals refunds ON refunds."orderId" = scoped."id"
      GROUP BY scoped.period, scoped.segment
      ORDER BY scoped.period, scoped.segment
    `);

    return rows.map((row) => ({
      period: row.period,
      segment: row.segment,
      orders: numeric(row.orders),
      units: numeric(row.units),
      orderValue: numeric(row.order_value),
      refunds: numeric(row.refunds),
      discounts: numeric(row.discounts),
    }));
  }

  async getProductEconomicsAggregates(
    input: CommerceAggregateInput,
  ): Promise<CommerceProductEconomicsAggregateRow[]> {
    const rows = await prisma.$queryRaw<RawCommerceProductEconomicsAggregateRow[]>(Prisma.sql`
      WITH scoped_lines AS (
        SELECT
          li."id",
          li."orderId",
          li."productId",
          li."variantId",
          li."quantity",
          COALESCE(li."discountedTotal", 0) AS product_revenue,
          COALESCE(o."processedAt", o."shopifyCreatedAt") AS order_at,
          CASE
            WHEN COALESCE(o."processedAt", o."shopifyCreatedAt") BETWEEN ${input.currentFrom} AND ${input.currentTo}
              THEN 'CURRENT'
            ELSE 'COMPARISON'
          END AS period
        FROM "OrderLineItem" li
        INNER JOIN "Order" o ON o."id" = li."orderId"
        WHERE li."productId" IS NOT NULL
          AND o."storeId" = ${input.storeId}::uuid
          AND o."isTest" = FALSE
          AND o."cancelledAt" IS NULL
          AND o."currencyCode" = ${input.currency}
          AND (
            COALESCE(o."processedAt", o."shopifyCreatedAt") BETWEEN ${input.currentFrom} AND ${input.currentTo}
            OR COALESCE(o."processedAt", o."shopifyCreatedAt") BETWEEN ${input.comparisonFrom} AND ${input.comparisonTo}
          )
      ),
      refund_line_totals AS (
        SELECT
          rli."orderLineItemId",
          COALESCE(SUM(rli."quantity"), 0) AS refunded_units,
          COALESCE(SUM(rli."subtotal"), 0) AS refunds,
          COALESCE(SUM(rli."quantity") FILTER (WHERE rli."restocked" = TRUE), 0) AS restocked_units
        FROM "RefundLineItem" rli
        INNER JOIN scoped_lines scoped ON scoped."id" = rli."orderLineItemId"
        GROUP BY rli."orderLineItemId"
      ),
      enriched_lines AS (
        SELECT
          scoped.*,
          COALESCE(refunds.refunded_units, 0) AS refunded_units,
          COALESCE(refunds.refunds, 0) AS refunds,
          GREATEST(scoped."quantity" - COALESCE(refunds.restocked_units, 0), 0) AS cost_relevant_units,
          unit_cost.amount AS unit_cost
        FROM scoped_lines scoped
        LEFT JOIN refund_line_totals refunds ON refunds."orderLineItemId" = scoped."id"
        LEFT JOIN LATERAL (
          SELECT cost."amount"
          FROM "VariantCost" cost
          WHERE cost."variantId" = scoped."variantId"
            AND cost."currency" = ${input.currency}
            AND cost."effectiveFrom" <= scoped.order_at
            AND (cost."effectiveUntil" IS NULL OR cost."effectiveUntil" > scoped.order_at)
          ORDER BY cost."effectiveFrom" DESC
          LIMIT 1
        ) unit_cost ON TRUE
      )
      SELECT
        period,
        "productId" AS product_id,
        COUNT(DISTINCT "orderId") AS order_count,
        COALESCE(SUM("quantity"), 0) AS sold_units,
        COALESCE(SUM(refunded_units), 0) AS refunded_units,
        COALESCE(SUM(product_revenue), 0) AS product_revenue,
        COALESCE(SUM(refunds), 0) AS refunds,
        COALESCE(SUM(unit_cost * cost_relevant_units) FILTER (WHERE unit_cost IS NOT NULL), 0) AS raw_cogs,
        COALESCE(SUM(cost_relevant_units) FILTER (WHERE unit_cost IS NOT NULL), 0) AS cost_covered_units,
        COALESCE(SUM(cost_relevant_units), 0) AS cost_relevant_units
      FROM enriched_lines
      GROUP BY period, "productId"
      ORDER BY period, "productId"
    `);

    return rows.map((row) => ({
      period: row.period,
      productId: row.product_id,
      orderCount: numeric(row.order_count),
      soldUnits: numeric(row.sold_units),
      refundedUnits: numeric(row.refunded_units),
      productRevenue: numeric(row.product_revenue),
      refunds: numeric(row.refunds),
      rawCogs: numeric(row.raw_cogs),
      costCoveredUnits: numeric(row.cost_covered_units),
      costRelevantUnits: numeric(row.cost_relevant_units),
    }));
  }
}
