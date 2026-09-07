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

type RawCommerceOrderAggregateRow = {
  period: CommerceOrderPeriod;
  segment: CommerceCustomerSegment;
  orders: bigint;
  units: bigint | number | null;
  order_value: Prisma.Decimal | string | number | null;
  refunds: Prisma.Decimal | string | number | null;
  discounts: Prisma.Decimal | string | number | null;
};

function numeric(value: Prisma.Decimal | string | number | bigint | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * High-volume Shopify order analytics read.
 *
 * PostgreSQL returns at most six rows (two periods x three customer segments), instead of
 * materializing every Order and Refund into Node just to calculate sums/counts.
 */
export class CommerceAnalyticsReadRepository {
  async getOrderAggregates(input: {
    storeId: string;
    currency: string;
    currentFrom: Date;
    currentTo: Date;
    comparisonFrom: Date;
    comparisonTo: Date;
  }): Promise<CommerceOrderAggregateRow[]> {
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
}
