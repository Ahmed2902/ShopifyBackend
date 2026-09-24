import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';

export type LegacyProductAdsPeriod = 'CURRENT' | 'COMPARISON';

type RawTotalRow = {
  period: LegacyProductAdsPeriod;
  net_product_revenue: Prisma.Decimal | string | number | null;
};

function decimal(value: Prisma.Decimal | string | number | null): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Compatibility-only full-scope commerce total. This returns at most two aggregate rows and never
 * loads the detailed product universe. Product selection, mapping, paid-media accounting and page
 * enrichment remain owned by UnifiedProductAdsService.
 */
export class LegacyProductAdsCompatibilityRepository {
  async netProductRevenueTotals(input: {
    storeId: string;
    currency: string;
    currentFrom: Date;
    currentTo: Date;
    comparisonFrom: Date;
    comparisonTo: Date;
  }): Promise<Record<LegacyProductAdsPeriod, number>> {
    const rows = await prisma.$queryRaw<RawTotalRow[]>(Prisma.sql`
      WITH scoped_lines AS (
        SELECT
          CASE
            WHEN COALESCE(orders."processedAt", orders."shopifyCreatedAt")
              BETWEEN ${input.currentFrom} AND ${input.currentTo}
              THEN 'CURRENT'
            ELSE 'COMPARISON'
          END AS period,
          line_item."id" AS line_item_id,
          line_item."productId" AS product_id,
          COALESCE(line_item."discountedTotal", 0) AS revenue
        FROM "OrderLineItem" line_item
        INNER JOIN "Order" orders ON orders."id" = line_item."orderId"
        WHERE line_item."productId" IS NOT NULL
          AND orders."storeId" = ${input.storeId}::uuid
          AND orders."isTest" = FALSE
          AND orders."cancelledAt" IS NULL
          AND orders."currencyCode" = ${input.currency}
          AND (
            COALESCE(orders."processedAt", orders."shopifyCreatedAt")
              BETWEEN ${input.currentFrom} AND ${input.currentTo}
            OR COALESCE(orders."processedAt", orders."shopifyCreatedAt")
              BETWEEN ${input.comparisonFrom} AND ${input.comparisonTo}
          )
      ),
      refund_by_line AS (
        SELECT
          scoped.period,
          scoped.line_item_id,
          COALESCE(SUM(refund_line."subtotal"), 0) AS refunds
        FROM scoped_lines scoped
        LEFT JOIN "RefundLineItem" refund_line
          ON refund_line."orderLineItemId" = scoped.line_item_id
        GROUP BY scoped.period, scoped.line_item_id
      ),
      product_totals AS (
        SELECT
          scoped.period,
          scoped.product_id,
          GREATEST(
            COALESCE(SUM(scoped.revenue), 0) - COALESCE(SUM(refunds.refunds), 0),
            0
          ) AS net_product_revenue
        FROM scoped_lines scoped
        LEFT JOIN refund_by_line refunds
          ON refunds.period = scoped.period
          AND refunds.line_item_id = scoped.line_item_id
        GROUP BY scoped.period, scoped.product_id
      )
      SELECT period, COALESCE(SUM(net_product_revenue), 0) AS net_product_revenue
      FROM product_totals
      GROUP BY period
    `);

    const result: Record<LegacyProductAdsPeriod, number> = {
      CURRENT: 0,
      COMPARISON: 0,
    };
    for (const row of rows) result[row.period] = decimal(row.net_product_revenue);
    return result;
  }
}
