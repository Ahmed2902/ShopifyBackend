import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import type { AdvertisingPlatform } from './advertising.types.js';

export type AdvertisingEvidenceBucket = 'CURRENT' | 'COMPARISON' | 'PRODUCT_ONLY';

export interface AdvertisingEvidenceRow {
  bucket: AdvertisingEvidenceBucket;
  sourceRowCount: number;
  date: Date;
  syncedAt: Date;
  currency: string | null;
  spend: number;
  impressions: number;
  clicks: number;
  frequency: number | null;
  conversions: number;
  conversionValue: number;
  campaign: {
    id: string;
    externalId: string;
    name: string;
  } | null;
  group: {
    id: string;
    externalId: string;
    name: string;
  } | null;
  ad: {
    id: string;
    externalId: string;
    name: string;
    creative: {
      id: string;
      externalId: string;
      name: string | null;
      title: string | null;
    } | null;
  } | null;
}

type RawEvidenceRow = {
  bucket: AdvertisingEvidenceBucket;
  source_row_count: bigint;
  synced_at: Date | null;
  currency: string | null;
  spend: Prisma.Decimal | string | number | null;
  impressions: bigint | number | null;
  clicks: bigint | number | null;
  conversions: Prisma.Decimal | string | number | null;
  conversion_value: Prisma.Decimal | string | number | null;
  weighted_frequency: Prisma.Decimal | string | number | null;
  campaign_id: string | null;
  campaign_external_id: string | null;
  campaign_name: string | null;
  group_id: string | null;
  group_external_id: string | null;
  group_name: string | null;
  ad_id: string | null;
  ad_external_id: string | null;
  ad_name: string | null;
  creative_id: string | null;
  creative_external_id: string | null;
  creative_name: string | null;
  creative_title: string | null;
};

function numeric(value: Prisma.Decimal | string | number | bigint | null): number {
  if (value === null) return 0;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * Canonical paid-media evidence for deterministic intelligence.
 *
 * This repository deliberately knows nothing about Meta action arrays, TikTok result metrics, or
 * future Google conversion-action payloads. Provider adapters normalize those semantics into the
 * scalar canonical fact columns before intelligence reads them.
 */
export class AdvertisingIntelligenceReadRepository {
  async getEvidenceRows(input: {
    storeId: string;
    provider: AdvertisingPlatform;
    selectedAccountExternalIds: string[];
    productFrom: Date;
    currentFrom: Date;
    currentTo: Date;
    comparisonFrom: Date;
    comparisonTo: Date;
  }): Promise<AdvertisingEvidenceRow[]> {
    if (input.selectedAccountExternalIds.length === 0) return [];
    const accountIds = Prisma.join(
      input.selectedAccountExternalIds.map((id) => Prisma.sql`${id}`),
    );

    const rows = await prisma.$queryRaw<RawEvidenceRow[]>(Prisma.sql`
      SELECT
        CASE
          WHEN metric."date" BETWEEN ${input.currentFrom} AND ${input.currentTo}
            THEN 'CURRENT'
          WHEN metric."date" BETWEEN ${input.comparisonFrom} AND ${input.comparisonTo}
            THEN 'COMPARISON'
          ELSE 'PRODUCT_ONLY'
        END AS bucket,
        COUNT(*) AS source_row_count,
        MAX(metric."syncedAt") AS synced_at,
        metric."currency" AS currency,
        COALESCE(SUM(metric."spend"), 0) AS spend,
        COALESCE(SUM(metric."impressions"), 0) AS impressions,
        COALESCE(SUM(metric."clicks"), 0) AS clicks,
        COALESCE(SUM(metric."conversions"), 0) AS conversions,
        COALESCE(SUM(metric."conversionValue"), 0) AS conversion_value,
        COALESCE(
          SUM(
            CASE
              WHEN metric."frequency" IS NOT NULL AND metric."impressions" > 0
                THEN metric."frequency" * metric."impressions"
              ELSE 0
            END
          ),
          0
        ) AS weighted_frequency,
        campaign."id" AS campaign_id,
        campaign."providerEntityId" AS campaign_external_id,
        campaign."name" AS campaign_name,
        delivery_group."id" AS group_id,
        delivery_group."providerEntityId" AS group_external_id,
        delivery_group."name" AS group_name,
        ad."id" AS ad_id,
        ad."providerEntityId" AS ad_external_id,
        ad."name" AS ad_name,
        creative."id" AS creative_id,
        creative."providerEntityId" AS creative_external_id,
        creative."name" AS creative_name,
        creative."title" AS creative_title
      FROM "AdvertisingDailyMetric" metric
      INNER JOIN "AdvertisingAccount" account ON account."id" = metric."accountId"
      LEFT JOIN "AdvertisingCampaign" campaign ON campaign."id" = metric."campaignId"
      LEFT JOIN "AdvertisingGroup" delivery_group ON delivery_group."id" = metric."groupId"
      LEFT JOIN "AdvertisingAd" ad ON ad."id" = metric."adId"
      LEFT JOIN "AdvertisingCreative" creative ON creative."id" = metric."creativeIdSnapshot"
      WHERE account."storeId" = ${input.storeId}::uuid
        AND account."provider" = ${input.provider}::"AdvertisingProvider"
        AND account."providerEntityId" IN (${accountIds})
        AND metric."level" = 'AD'::"AdvertisingMetricLevel"
        AND metric."date" BETWEEN ${input.productFrom} AND ${input.currentTo}
      GROUP BY
        bucket,
        metric."currency",
        campaign."id",
        campaign."providerEntityId",
        campaign."name",
        delivery_group."id",
        delivery_group."providerEntityId",
        delivery_group."name",
        ad."id",
        ad."providerEntityId",
        ad."name",
        creative."id",
        creative."providerEntityId",
        creative."name",
        creative."title"
      ORDER BY bucket, metric."currency" NULLS LAST, ad."id" NULLS LAST
    `);

    return rows.map((row) => {
      const impressions = numeric(row.impressions);
      const weightedFrequency = numeric(row.weighted_frequency);
      const date =
        row.bucket === 'CURRENT'
          ? input.currentFrom
          : row.bucket === 'COMPARISON'
            ? input.comparisonFrom
            : input.productFrom;
      return {
        bucket: row.bucket,
        sourceRowCount: numeric(row.source_row_count),
        date,
        syncedAt: row.synced_at ?? date,
        currency: row.currency,
        spend: numeric(row.spend),
        impressions,
        clicks: numeric(row.clicks),
        frequency: impressions > 0 ? weightedFrequency / impressions : null,
        conversions: numeric(row.conversions),
        conversionValue: numeric(row.conversion_value),
        campaign:
          row.campaign_id && row.campaign_external_id && row.campaign_name
            ? { id: row.campaign_id, externalId: row.campaign_external_id, name: row.campaign_name }
            : null,
        group:
          row.group_id && row.group_external_id && row.group_name
            ? { id: row.group_id, externalId: row.group_external_id, name: row.group_name }
            : null,
        ad:
          row.ad_id && row.ad_external_id && row.ad_name
            ? {
                id: row.ad_id,
                externalId: row.ad_external_id,
                name: row.ad_name,
                creative:
                  row.creative_id && row.creative_external_id
                    ? {
                        id: row.creative_id,
                        externalId: row.creative_external_id,
                        name: row.creative_name,
                        title: row.creative_title,
                      }
                    : null,
              }
            : null,
      };
    });
  }

  async getLatestMetricSyncedAt(input: {
    storeId: string;
    provider: AdvertisingPlatform;
    selectedAccountExternalIds: string[];
  }): Promise<{ syncedAt: Date } | null> {
    if (input.selectedAccountExternalIds.length === 0) return null;
    return prisma.advertisingDailyMetric.findFirst({
      where: {
        level: 'AD',
        account: {
          storeId: input.storeId,
          provider: input.provider,
          providerEntityId: { in: input.selectedAccountExternalIds },
        },
      },
      orderBy: { syncedAt: 'desc' },
      select: { syncedAt: true },
    });
  }
}

export const advertisingIntelligenceReadRepository = new AdvertisingIntelligenceReadRepository();
