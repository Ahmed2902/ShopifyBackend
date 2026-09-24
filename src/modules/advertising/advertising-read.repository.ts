import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import type { AdvertisingPlatform } from './advertising.types.js';

export type AdvertisingReadPeriod = 'CURRENT' | 'COMPARISON';
export type AdvertisingReadEntityKind = 'CAMPAIGN' | 'GROUP' | 'AD' | 'CREATIVE';

export interface AdvertisingAggregateRow {
  period: AdvertisingReadPeriod;
  currency: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  conversions: number | null;
  conversionValue: number | null;
  weightedFrequency: number;
  attributionSettings: string[];
}

export interface AdvertisingEntityAggregateRow extends Omit<AdvertisingAggregateRow, 'attributionSettings'> {
  entityId: string;
}

export interface AdvertisingAdAggregateRow extends Omit<AdvertisingAggregateRow, 'attributionSettings'> {
  adId: string | null;
}

export interface AdvertisingOverviewMeta {
  campaigns: number;
  ads: number;
  latestMetricSyncedAt: Date | null;
  latestHierarchySyncedAt: Date | null;
}

export interface AdvertisingProductMappingSummaryRow {
  adId: string;
  adExternalId: string;
  productId: string;
  variantId: string | null;
  source: string;
  confidence: Prisma.Decimal;
  isMerchantConfirmed: boolean;
  product: {
    id: string;
    shopifyProductId: string;
    title: string;
    status: string;
    deletedAt: Date | null;
  };
}

type RawAggregateRow = {
  period: AdvertisingReadPeriod;
  currency: string | null;
  spend: Prisma.Decimal | string | number | null;
  impressions: bigint | number | null;
  clicks: bigint | number | null;
  conversions: Prisma.Decimal | string | number | null;
  conversion_value: Prisma.Decimal | string | number | null;
  weighted_frequency: Prisma.Decimal | string | number | null;
  attribution_settings: string[] | null;
};

type RawEntityAggregateRow = Omit<RawAggregateRow, 'attribution_settings'> & {
  entity_id: string;
};

type RawAdAggregateRow = Omit<RawAggregateRow, 'attribution_settings'> & {
  ad_id: string | null;
};

function numeric(value: Prisma.Decimal | string | number | bigint | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullableNumeric(
  value: Prisma.Decimal | string | number | bigint | null,
): number | null {
  if (value === null) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function selectedAccountFilter(externalIds: string[]) {
  if (externalIds.length === 0) return Prisma.sql`FALSE`;
  return Prisma.sql`account."providerEntityId" IN (${Prisma.join(
    externalIds.map((id) => Prisma.sql`${id}`),
  )})`;
}

function entityColumn(kind: AdvertisingReadEntityKind) {
  if (kind === 'CAMPAIGN') return Prisma.raw('metric."campaignId"');
  if (kind === 'GROUP') return Prisma.raw('metric."groupId"');
  if (kind === 'AD') return Prisma.raw('metric."adId"');
  return Prisma.raw('metric."creativeIdSnapshot"');
}

function aggregate(row: RawAggregateRow): AdvertisingAggregateRow {
  return {
    period: row.period,
    currency: row.currency,
    spend: numeric(row.spend),
    impressions: numeric(row.impressions),
    clicks: numeric(row.clicks),
    conversions: nullableNumeric(row.conversions),
    conversionValue: nullableNumeric(row.conversion_value),
    weightedFrequency: numeric(row.weighted_frequency),
    attributionSettings: row.attribution_settings ?? [],
  };
}

/**
 * Provider-neutral read boundary over Stride's canonical paid-media persistence.
 *
 * Provider interpretation belongs at ingestion. In particular, Meta purchase action selection is
 * normalized before data reaches AdvertisingDailyMetric, so consumers aggregate conversions/value
 * directly instead of repeating provider-specific action-array logic. Nullable attribution is
 * fail-closed: if any source fact in an aggregate is unavailable, the aggregate attribution field
 * remains unavailable instead of publishing a partial total or a fabricated zero.
 */
export class AdvertisingReadRepository {
  async getOverviewAggregateRows(input: {
    storeId: string;
    provider: AdvertisingPlatform;
    selectedAccountExternalIds: string[];
    currentFrom: Date;
    currentTo: Date;
    comparisonFrom: Date;
    comparisonTo: Date;
  }): Promise<AdvertisingAggregateRow[]> {
    if (input.selectedAccountExternalIds.length === 0) return [];
    const accountFilter = selectedAccountFilter(input.selectedAccountExternalIds);

    const rows = await prisma.$queryRaw<RawAggregateRow[]>(Prisma.sql`
      WITH scoped_metrics AS (
        SELECT
          CASE
            WHEN metric."date" BETWEEN ${input.currentFrom} AND ${input.currentTo}
              THEN 'CURRENT'
            ELSE 'COMPARISON'
          END AS period,
          metric."currency" AS currency,
          metric."spend",
          metric."impressions",
          metric."clicks",
          metric."conversions",
          metric."conversionValue" AS conversion_value,
          metric."frequency",
          NULLIF(metric."providerMetrics" ->> 'attributionSetting', '') AS attribution_setting
        FROM "AdvertisingDailyMetric" metric
        INNER JOIN "AdvertisingAccount" account ON account."id" = metric."accountId"
        WHERE account."storeId" = ${input.storeId}::uuid
          AND account."provider" = ${input.provider}::"AdvertisingProvider"
          AND ${accountFilter}
          AND metric."level" = 'AD'::"AdvertisingMetricLevel"
          AND (
            metric."date" BETWEEN ${input.currentFrom} AND ${input.currentTo}
            OR metric."date" BETWEEN ${input.comparisonFrom} AND ${input.comparisonTo}
          )
      )
      SELECT
        scoped.period,
        scoped.currency,
        COALESCE(SUM(scoped."spend"), 0) AS spend,
        COALESCE(SUM(scoped."impressions"), 0) AS impressions,
        COALESCE(SUM(scoped."clicks"), 0) AS clicks,
        CASE
          WHEN COUNT(scoped."conversions") = COUNT(*) THEN SUM(scoped."conversions")
          ELSE NULL
        END AS conversions,
        CASE
          WHEN COUNT(scoped.conversion_value) = COUNT(*) THEN SUM(scoped.conversion_value)
          ELSE NULL
        END AS conversion_value,
        COALESCE(
          SUM(
            CASE
              WHEN scoped."frequency" IS NOT NULL AND scoped."impressions" > 0
                THEN scoped."frequency" * scoped."impressions"
              ELSE 0
            END
          ),
          0
        ) AS weighted_frequency,
        COALESCE(
          ARRAY_AGG(DISTINCT scoped.attribution_setting) FILTER (
            WHERE scoped.attribution_setting IS NOT NULL
          ),
          ARRAY[]::text[]
        ) AS attribution_settings
      FROM scoped_metrics scoped
      GROUP BY scoped.period, scoped.currency
      ORDER BY scoped.period, scoped.currency NULLS LAST
    `);

    return rows.map(aggregate);
  }

  async getOverviewMeta(input: {
    storeId: string;
    provider: AdvertisingPlatform;
    selectedAccountExternalIds: string[];
  }): Promise<AdvertisingOverviewMeta> {
    if (input.selectedAccountExternalIds.length === 0) {
      return {
        campaigns: 0,
        ads: 0,
        latestMetricSyncedAt: null,
        latestHierarchySyncedAt: null,
      };
    }
    const accountFilter = selectedAccountFilter(input.selectedAccountExternalIds);
    const [row] = await prisma.$queryRaw<
      Array<{
        campaigns: bigint;
        ads: bigint;
        latest_metric_synced_at: Date | null;
        latest_hierarchy_synced_at: Date | null;
      }>
    >(Prisma.sql`
      WITH selected_accounts AS (
        SELECT account."id", account."lastSyncedAt"
        FROM "AdvertisingAccount" account
        WHERE account."storeId" = ${input.storeId}::uuid
          AND account."provider" = ${input.provider}::"AdvertisingProvider"
          AND ${accountFilter}
      )
      SELECT
        (
          SELECT COUNT(*)
          FROM "AdvertisingCampaign" campaign
          WHERE campaign."accountId" IN (SELECT "id" FROM selected_accounts)
            AND campaign."deletedAt" IS NULL
        ) AS campaigns,
        (
          SELECT COUNT(*)
          FROM "AdvertisingAd" ad
          WHERE ad."accountId" IN (SELECT "id" FROM selected_accounts)
            AND ad."deletedAt" IS NULL
        ) AS ads,
        (
          SELECT MAX(metric."syncedAt")
          FROM "AdvertisingDailyMetric" metric
          WHERE metric."accountId" IN (SELECT "id" FROM selected_accounts)
            AND metric."level" = 'AD'::"AdvertisingMetricLevel"
        ) AS latest_metric_synced_at,
        (SELECT MAX("lastSyncedAt") FROM selected_accounts) AS latest_hierarchy_synced_at
    `);

    return {
      campaigns: Number(row?.campaigns ?? 0),
      ads: Number(row?.ads ?? 0),
      latestMetricSyncedAt: row?.latest_metric_synced_at ?? null,
      latestHierarchySyncedAt: row?.latest_hierarchy_synced_at ?? null,
    };
  }

  async getEntityAggregateRows(input: {
    storeId: string;
    provider: AdvertisingPlatform;
    selectedAccountExternalIds: string[];
    entityIds: string[];
    kind: AdvertisingReadEntityKind;
    currentFrom: Date;
    currentTo: Date;
    comparisonFrom: Date;
    comparisonTo: Date;
  }): Promise<AdvertisingEntityAggregateRow[]> {
    if (input.selectedAccountExternalIds.length === 0 || input.entityIds.length === 0) return [];
    const accountFilter = selectedAccountFilter(input.selectedAccountExternalIds);
    const entityIds = Prisma.join(input.entityIds.map((id) => Prisma.sql`${id}::uuid`));
    const column = entityColumn(input.kind);

    const rows = await prisma.$queryRaw<RawEntityAggregateRow[]>(Prisma.sql`
      SELECT
        CASE
          WHEN metric."date" BETWEEN ${input.currentFrom} AND ${input.currentTo}
            THEN 'CURRENT'
          ELSE 'COMPARISON'
        END AS period,
        ${column} AS entity_id,
        metric."currency" AS currency,
        COALESCE(SUM(metric."spend"), 0) AS spend,
        COALESCE(SUM(metric."impressions"), 0) AS impressions,
        COALESCE(SUM(metric."clicks"), 0) AS clicks,
        CASE
          WHEN COUNT(metric."conversions") = COUNT(*) THEN SUM(metric."conversions")
          ELSE NULL
        END AS conversions,
        CASE
          WHEN COUNT(metric."conversionValue") = COUNT(*) THEN SUM(metric."conversionValue")
          ELSE NULL
        END AS conversion_value,
        COALESCE(
          SUM(
            CASE
              WHEN metric."frequency" IS NOT NULL AND metric."impressions" > 0
                THEN metric."frequency" * metric."impressions"
              ELSE 0
            END
          ),
          0
        ) AS weighted_frequency
      FROM "AdvertisingDailyMetric" metric
      INNER JOIN "AdvertisingAccount" account ON account."id" = metric."accountId"
      WHERE account."storeId" = ${input.storeId}::uuid
        AND account."provider" = ${input.provider}::"AdvertisingProvider"
        AND ${accountFilter}
        AND metric."level" = 'AD'::"AdvertisingMetricLevel"
        AND ${column} IN (${entityIds})
        AND (
          metric."date" BETWEEN ${input.currentFrom} AND ${input.currentTo}
          OR metric."date" BETWEEN ${input.comparisonFrom} AND ${input.comparisonTo}
        )
      GROUP BY period, entity_id, metric."currency"
      ORDER BY entity_id, period, metric."currency" NULLS LAST
    `);

    return rows.map((row) => ({
      period: row.period,
      entityId: row.entity_id,
      currency: row.currency,
      spend: numeric(row.spend),
      impressions: numeric(row.impressions),
      clicks: numeric(row.clicks),
      conversions: nullableNumeric(row.conversions),
      conversionValue: nullableNumeric(row.conversion_value),
      weightedFrequency: numeric(row.weighted_frequency),
    }));
  }

  async getAdAggregateRows(input: {
    storeId: string;
    provider: AdvertisingPlatform;
    selectedAccountExternalIds: string[];
    currentFrom: Date;
    currentTo: Date;
    comparisonFrom: Date;
    comparisonTo: Date;
    adIds?: string[];
  }): Promise<AdvertisingAdAggregateRow[]> {
    if (input.selectedAccountExternalIds.length === 0) return [];
    if (input.adIds && input.adIds.length === 0) return [];
    const accountFilter = selectedAccountFilter(input.selectedAccountExternalIds);
    const adFilter = input.adIds
      ? Prisma.sql`AND metric."adId" IN (${Prisma.join(
          input.adIds.map((id) => Prisma.sql`${id}::uuid`),
        )})`
      : Prisma.empty;

    const rows = await prisma.$queryRaw<RawAdAggregateRow[]>(Prisma.sql`
      SELECT
        CASE
          WHEN metric."date" BETWEEN ${input.currentFrom} AND ${input.currentTo}
            THEN 'CURRENT'
          ELSE 'COMPARISON'
        END AS period,
        metric."adId" AS ad_id,
        metric."currency" AS currency,
        COALESCE(SUM(metric."spend"), 0) AS spend,
        COALESCE(SUM(metric."impressions"), 0) AS impressions,
        COALESCE(SUM(metric."clicks"), 0) AS clicks,
        CASE
          WHEN COUNT(metric."conversions") = COUNT(*) THEN SUM(metric."conversions")
          ELSE NULL
        END AS conversions,
        CASE
          WHEN COUNT(metric."conversionValue") = COUNT(*) THEN SUM(metric."conversionValue")
          ELSE NULL
        END AS conversion_value,
        COALESCE(
          SUM(
            CASE
              WHEN metric."frequency" IS NOT NULL AND metric."impressions" > 0
                THEN metric."frequency" * metric."impressions"
              ELSE 0
            END
          ),
          0
        ) AS weighted_frequency
      FROM "AdvertisingDailyMetric" metric
      INNER JOIN "AdvertisingAccount" account ON account."id" = metric."accountId"
      WHERE account."storeId" = ${input.storeId}::uuid
        AND account."provider" = ${input.provider}::"AdvertisingProvider"
        AND ${accountFilter}
        AND metric."level" = 'AD'::"AdvertisingMetricLevel"
        AND (
          metric."date" BETWEEN ${input.currentFrom} AND ${input.currentTo}
          OR metric."date" BETWEEN ${input.comparisonFrom} AND ${input.comparisonTo}
        )
        ${adFilter}
      GROUP BY period, metric."adId", metric."currency"
      ORDER BY period, metric."currency" NULLS LAST, metric."adId" NULLS LAST
    `);

    return rows.map((row) => ({
      period: row.period,
      adId: row.ad_id,
      currency: row.currency,
      spend: numeric(row.spend),
      impressions: numeric(row.impressions),
      clicks: numeric(row.clicks),
      conversions: nullableNumeric(row.conversions),
      conversionValue: nullableNumeric(row.conversion_value),
      weightedFrequency: numeric(row.weighted_frequency),
    }));
  }

  getActiveProductMappings(input: {
    storeId: string;
    provider: AdvertisingPlatform;
    selectedAccountExternalIds: string[];
  }): Promise<AdvertisingProductMappingSummaryRow[]> {
    if (input.selectedAccountExternalIds.length === 0) return Promise.resolve([]);

    return prisma.advertisingProductMapping.findMany({
      where: {
        validUntil: null,
        ad: {
          deletedAt: null,
          account: {
            storeId: input.storeId,
            provider: input.provider,
            providerEntityId: { in: input.selectedAccountExternalIds },
          },
        },
        product: { storeId: input.storeId },
      },
      select: {
        adId: true,
        productId: true,
        variantId: true,
        source: true,
        confidence: true,
        isMerchantConfirmed: true,
        ad: { select: { providerEntityId: true } },
        product: {
          select: {
            id: true,
            shopifyProductId: true,
            title: true,
            status: true,
            deletedAt: true,
          },
        },
      },
      orderBy: [{ adId: 'asc' }, { productId: 'asc' }, { variantId: 'asc' }],
    }).then((rows) =>
      rows.map((row) => ({
        adId: row.adId,
        adExternalId: row.ad.providerEntityId,
        productId: row.productId,
        variantId: row.variantId,
        source: row.source,
        confidence: row.confidence,
        isMerchantConfirmed: row.isMerchantConfirmed,
        product: row.product,
      })),
    );
  }
}

export const advertisingReadRepository = new AdvertisingReadRepository();
