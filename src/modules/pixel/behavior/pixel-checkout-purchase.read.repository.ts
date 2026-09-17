import { Prisma } from '../../../generated/prisma/client.js';
import { prisma } from '../../../lib/prisma.js';

export interface CheckoutPurchaseOverlapCounts {
  current: number;
  comparison: number;
}

type RawOverlapRow = {
  period: 'CURRENT' | 'COMPARISON';
  session_count: bigint | number;
};

function numeric(value: bigint | number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Counts strict same-session checkout -> valid Shopify purchase overlap.
 *
 * A valid purchase mirrors the behavior rollup's Shopify truth semantics:
 * the session is linked to a non-test, non-cancelled Shopify order. This is
 * intentionally distinct from observing a Pixel CHECKOUT_COMPLETED event.
 */
export class PixelCheckoutPurchaseReadRepository {
  async getOverlapCounts(input: {
    storeId: string;
    currentFrom: Date;
    currentTo: Date;
    comparisonFrom: Date;
    comparisonTo: Date;
  }): Promise<CheckoutPurchaseOverlapCounts> {
    const rows = await prisma.$queryRaw<RawOverlapRow[]>(Prisma.sql`
      SELECT
        CASE
          WHEN session."startedAt" BETWEEN ${input.currentFrom} AND ${input.currentTo}
            THEN 'CURRENT'
          ELSE 'COMPARISON'
        END AS period,
        COUNT(*) AS session_count
      FROM "StorefrontSession" session
      INNER JOIN "Order" purchase
        ON purchase."id" = session."orderId"
        AND purchase."storeId" = session."storeId"
        AND purchase."isTest" = FALSE
        AND purchase."cancelledAt" IS NULL
      WHERE session."storeId" = ${input.storeId}::uuid
        AND session."eventCount" > 0
        AND session."checkoutStartedAt" IS NOT NULL
        AND (
          session."startedAt" BETWEEN ${input.currentFrom} AND ${input.currentTo}
          OR session."startedAt" BETWEEN ${input.comparisonFrom} AND ${input.comparisonTo}
        )
      GROUP BY period
    `);

    const result: CheckoutPurchaseOverlapCounts = { current: 0, comparison: 0 };
    for (const row of rows) {
      if (row.period === 'CURRENT') result.current = numeric(row.session_count);
      else result.comparison = numeric(row.session_count);
    }
    return result;
  }
}

export const pixelCheckoutPurchaseReadRepository = new PixelCheckoutPurchaseReadRepository();
