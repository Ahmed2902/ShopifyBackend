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

function finish(rows: RawOverlapRow[]): CheckoutPurchaseOverlapCounts {
  const result: CheckoutPurchaseOverlapCounts = { current: 0, comparison: 0 };
  for (const row of rows) {
    if (row.period === 'CURRENT') result.current = numeric(row.session_count);
    else result.comparison = numeric(row.session_count);
  }
  return result;
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

    return finish(rows);
  }

  /**
   * Same overlap read keyed by store-local calendar dates so it lines up with
   * StorefrontBehaviorDaily bucket semantics used by Intelligence snapshots.
   */
  async getOverlapCountsForStoreDates(input: {
    storeId: string;
    currentFrom: Date;
    currentTo: Date;
    comparisonFrom: Date;
    comparisonTo: Date;
  }): Promise<CheckoutPurchaseOverlapCounts> {
    const rows = await prisma.$queryRaw<RawOverlapRow[]>(Prisma.sql`
      SELECT
        CASE
          WHEN local_session.local_date BETWEEN ${input.currentFrom}::date AND ${input.currentTo}::date
            THEN 'CURRENT'
          ELSE 'COMPARISON'
        END AS period,
        COUNT(*) AS session_count
      FROM (
        SELECT
          session."id",
          session."storeId",
          session."orderId",
          session."eventCount",
          session."checkoutStartedAt",
          ((session."startedAt" AT TIME ZONE 'UTC') AT TIME ZONE store."ianaTimezone")::date AS local_date
        FROM "StorefrontSession" session
        INNER JOIN "Store" store ON store."id" = session."storeId"
        WHERE session."storeId" = ${input.storeId}::uuid
      ) local_session
      INNER JOIN "Order" purchase
        ON purchase."id" = local_session."orderId"
        AND purchase."storeId" = local_session."storeId"
        AND purchase."isTest" = FALSE
        AND purchase."cancelledAt" IS NULL
      WHERE local_session."eventCount" > 0
        AND local_session."checkoutStartedAt" IS NOT NULL
        AND (
          local_session.local_date BETWEEN ${input.currentFrom}::date AND ${input.currentTo}::date
          OR local_session.local_date BETWEEN ${input.comparisonFrom}::date AND ${input.comparisonTo}::date
        )
      GROUP BY period
    `);

    return finish(rows);
  }
}

export const pixelCheckoutPurchaseReadRepository = new PixelCheckoutPurchaseReadRepository();
