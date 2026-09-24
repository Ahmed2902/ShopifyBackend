import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import type { PaidEntityEvidence } from './paid-entity-intelligence.metrics.js';

type RawAdSetEvidenceRow = {
  period: 'CURRENT' | 'COMPARISON';
  account_currency: string;
  ad_set_id: string;
  ad_set_external_id: string;
  ad_set_name: string;
  spend: Prisma.Decimal | string | number | null;
  impressions: bigint | number | null;
  clicks: bigint | number | null;
  purchases: Prisma.Decimal | string | number | null;
  purchase_value: Prisma.Decimal | string | number | null;
};

function numeric(value: Prisma.Decimal | string | number | bigint | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Period-level delivery-group evidence from canonical AD facts. */
export class IntelligenceAdSetReadRepository {
  async getEvidence(input: {
    storeId: string;
    selectedAccountIds: string[];
    currentFrom: Date;
    currentTo: Date;
    comparisonFrom: Date;
    comparisonTo: Date;
  }): Promise<PaidEntityEvidence[]> {
    if (input.selectedAccountIds.length === 0) return [];
    const accountIds = Prisma.join(input.selectedAccountIds.map((id) => Prisma.sql`${id}`));

    const rows = await prisma.$queryRaw<RawAdSetEvidenceRow[]>(Prisma.sql`
      SELECT
        CASE
          WHEN metric."date" BETWEEN ${input.currentFrom} AND ${input.currentTo}
            THEN 'CURRENT'
          ELSE 'COMPARISON'
        END AS period,
        COALESCE(metric."currency", account."currency", '') AS account_currency,
        delivery_group."id" AS ad_set_id,
        delivery_group."providerEntityId" AS ad_set_external_id,
        delivery_group."name" AS ad_set_name,
        COALESCE(SUM(metric."spend"), 0) AS spend,
        COALESCE(SUM(metric."impressions"), 0) AS impressions,
        COALESCE(SUM(metric."clicks"), 0) AS clicks,
        COALESCE(SUM(metric."conversions"), 0) AS purchases,
        COALESCE(SUM(metric."conversionValue"), 0) AS purchase_value
      FROM "AdvertisingDailyMetric" metric
      INNER JOIN "AdvertisingAccount" account ON account."id" = metric."accountId"
      INNER JOIN "AdvertisingGroup" delivery_group ON delivery_group."id" = metric."groupId"
      WHERE account."storeId" = ${input.storeId}::uuid
        AND account."provider" = 'META'::"AdvertisingProvider"
        AND account."providerEntityId" IN (${accountIds})
        AND delivery_group."kind" = 'AD_SET'::"AdvertisingGroupKind"
        AND metric."level" = 'AD'::"AdvertisingMetricLevel"
        AND (
          metric."date" BETWEEN ${input.currentFrom} AND ${input.currentTo}
          OR metric."date" BETWEEN ${input.comparisonFrom} AND ${input.comparisonTo}
        )
      GROUP BY
        period,
        account_currency,
        delivery_group."id",
        delivery_group."providerEntityId",
        delivery_group."name"
      ORDER BY account_currency, delivery_group."id", period
    `);

    const groups = new Map<
      string,
      {
        entityId: string;
        externalEntityId: string;
        name: string;
        currency: string;
        current: PaidEntityEvidence['current'];
        comparison: PaidEntityEvidence['comparison'];
      }
    >();
    const currentSpendByCurrency = new Map<string, number>();
    const empty = (): PaidEntityEvidence['current'] => ({
      spend: 0,
      impressions: 0,
      reach: null,
      clicks: 0,
      purchases: 0,
      purchaseValue: 0,
      roas: null,
      cpa: null,
      ctr: null,
      cpc: null,
      cpm: null,
      frequency: null,
    });

    for (const row of rows) {
      const spend = numeric(row.spend);
      const impressions = numeric(row.impressions);
      const clicks = numeric(row.clicks);
      const purchases = numeric(row.purchases);
      const purchaseValue = numeric(row.purchase_value);
      const metrics: PaidEntityEvidence['current'] = {
        spend,
        impressions,
        reach: null,
        clicks,
        purchases,
        purchaseValue,
        roas: spend > 0 ? purchaseValue / spend : null,
        cpa: purchases > 0 ? spend / purchases : null,
        ctr: impressions > 0 ? clicks / impressions : null,
        cpc: clicks > 0 ? spend / clicks : null,
        cpm: impressions > 0 ? (spend / impressions) * 1_000 : null,
        frequency: null,
      };
      const key = `${row.account_currency}:${row.ad_set_id}`;
      const group = groups.get(key) ?? {
        entityId: row.ad_set_id,
        externalEntityId: row.ad_set_external_id,
        name: row.ad_set_name,
        currency: row.account_currency,
        current: empty(),
        comparison: empty(),
      };
      if (row.period === 'CURRENT') {
        group.current = metrics;
        currentSpendByCurrency.set(
          row.account_currency,
          (currentSpendByCurrency.get(row.account_currency) ?? 0) + spend,
        );
      } else {
        group.comparison = metrics;
      }
      groups.set(key, group);
    }

    return [...groups.values()].map((group) => ({
      ...group,
      spendShare:
        (currentSpendByCurrency.get(group.currency) ?? 0) > 0
          ? group.current.spend / (currentSpendByCurrency.get(group.currency) ?? 1)
          : 0,
    }));
  }
}
