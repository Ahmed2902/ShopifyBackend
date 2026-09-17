import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import type { CommerceHealthEvidence, CommerceHealthMetrics } from './intelligence.types.js';

type RawCommerceHealthRow = {
  period: 'CURRENT' | 'COMPARISON';
  orders: bigint | number;
  order_value: Prisma.Decimal | string | number | null;
  refunds: Prisma.Decimal | string | number | null;
  discounts: Prisma.Decimal | string | number | null;
  new_orders: bigint | number | null;
  returning_orders: bigint | number | null;
  unknown_customer_orders: bigint | number | null;
};

function numeric(value: Prisma.Decimal | string | number | bigint | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function metrics(row: RawCommerceHealthRow | undefined): CommerceHealthMetrics {
  const orders = numeric(row?.orders ?? 0);
  const orderValue = numeric(row?.order_value ?? 0);
  const refunds = numeric(row?.refunds ?? 0);
  const discounts = numeric(row?.discounts ?? 0);
  const newOrders = numeric(row?.new_orders ?? 0);
  const returningOrders = numeric(row?.returning_orders ?? 0);
  const unknownCustomerOrders = numeric(row?.unknown_customer_orders ?? 0);
  const knownOrders = newOrders + returningOrders;

  return {
    orders,
    orderValue,
    refunds,
    discounts,
    refundRate: rate(refunds, orderValue + refunds),
    discountRate: rate(discounts, orderValue + discounts),
    newOrders,
    returningOrders,
    unknownCustomerOrders,
    knownCustomerCoverage: rate(knownOrders, orders),
    returningOrderShare: rate(returningOrders, knownOrders),
  };
}

/** Store-level Shopify health signals that complement product economics. */
export class IntelligenceCommerceHealthReadRepository {
  async getEvidence(input: {
    storeId: string;
    currency: string;
    currentFrom: Date;
    currentTo: Date;
    comparisonFrom: Date;
    comparisonTo: Date;
  }): Promise<CommerceHealthEvidence> {
    const rows = await prisma.$queryRaw<RawCommerceHealthRow[]>(Prisma.sql`
      WITH scoped_orders AS (
        SELECT
          o."id",
          o."currentTotalAmount",
          o."currentTotalDiscountsAmount",
          o."customerJourneyReady",
          o."customerOrderIndex",
          CASE
            WHEN COALESCE(o."processedAt", o."shopifyCreatedAt") BETWEEN ${input.currentFrom} AND ${input.currentTo}
              THEN 'CURRENT'
            ELSE 'COMPARISON'
          END AS period
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
          refund."orderId" AS order_id,
          COALESCE(SUM(refund."totalRefunded"), 0) AS refunds
        FROM "Refund" refund
        INNER JOIN scoped_orders scoped ON scoped."id" = refund."orderId"
        WHERE refund."currencyCode" IS NULL OR refund."currencyCode" = ${input.currency}
        GROUP BY refund."orderId"
      )
      SELECT
        scoped.period,
        COUNT(*) AS orders,
        COALESCE(SUM(scoped."currentTotalAmount"), 0) AS order_value,
        COALESCE(SUM(refunds.refunds), 0) AS refunds,
        COALESCE(SUM(scoped."currentTotalDiscountsAmount"), 0) AS discounts,
        COUNT(*) FILTER (
          WHERE scoped."customerJourneyReady" IS TRUE AND scoped."customerOrderIndex" = 1
        ) AS new_orders,
        COUNT(*) FILTER (
          WHERE scoped."customerJourneyReady" IS TRUE AND scoped."customerOrderIndex" > 1
        ) AS returning_orders,
        COUNT(*) FILTER (
          WHERE scoped."customerJourneyReady" IS NOT TRUE OR scoped."customerOrderIndex" IS NULL OR scoped."customerOrderIndex" < 1
        ) AS unknown_customer_orders
      FROM scoped_orders scoped
      LEFT JOIN refund_totals refunds ON refunds.order_id = scoped."id"
      GROUP BY scoped.period
      ORDER BY scoped.period
    `);

    return {
      current: metrics(rows.find((row) => row.period === 'CURRENT')),
      comparison: metrics(rows.find((row) => row.period === 'COMPARISON')),
    };
  }
}
