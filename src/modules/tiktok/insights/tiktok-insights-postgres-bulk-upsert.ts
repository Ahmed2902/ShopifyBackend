import { randomUUID } from 'node:crypto';
import { Prisma } from '../../../generated/prisma/client.js';

export type TikTokInsightBulkClient = Pick<Prisma.TransactionClient, '$queryRaw'>;

type BulkResult = { id: string; insight_key: string };

type DecimalLike = Prisma.Decimal | number | string | null | undefined;
type BigIntLike = bigint | number | string | null | undefined;

function decimal(value: DecimalLike): string | null {
  if (value === null || value === undefined) return null;
  return value instanceof Prisma.Decimal ? value.toString() : String(value);
}

function integer(value: BigIntLike): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function iso(value: Date | string | null | undefined, fallback = new Date()): string {
  if (value === null || value === undefined) return fallback.toISOString();
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

function jsonPayload(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (item instanceof Prisma.Decimal) return item.toString();
    return item;
  });
}

function providerMetrics(input: Prisma.TikTokInsightDailyUncheckedCreateInput) {
  return {
    resultCount: decimal(input.resultCount),
    costPerResult: decimal(input.costPerResult),
    videoPlayActions: integer(input.videoPlayActions),
    videoWatched2s: integer(input.videoWatched2s),
    videoWatched6s: integer(input.videoWatched6s),
    videoViewsP25: integer(input.videoViewsP25),
    videoViewsP50: integer(input.videoViewsP50),
    videoViewsP75: integer(input.videoViewsP75),
    videoViewsP100: integer(input.videoViewsP100),
    likes: integer(input.likes),
    comments: integer(input.comments),
    shares: integer(input.shares),
    follows: integer(input.follows),
    profileVisits: integer(input.profileVisits),
    objectiveType: input.objectiveType ?? null,
    optimizationGoal: input.optimizationGoal ?? null,
    attributionWindow: input.attributionWindow ?? null,
    dimensions: input.dimensionsJson ?? null,
    metrics: input.metricsJson ?? null,
  };
}

function metricLevel(level: Prisma.TikTokInsightDailyUncheckedCreateInput['level']) {
  if (level === 'ADVERTISER') return 'ACCOUNT';
  if (level === 'CAMPAIGN') return 'CAMPAIGN';
  if (level === 'ADGROUP') return 'GROUP';
  return 'AD';
}

/**
 * PostgreSQL boundary for the TikTok report hot path.
 *
 * A batch is persisted with one database statement: the first data-modifying CTE upserts native
 * TikTok evidence by insightKey and the second projects the exact returned native rows into the
 * canonical AdvertisingDailyMetric table by metricKey. If either write fails, PostgreSQL aborts
 * the whole statement; callers additionally execute it inside the sync transaction so native and
 * canonical facts can never commit independently.
 */
export async function bulkUpsertTikTokInsights(
  db: TikTokInsightBulkClient,
  inputs: Prisma.TikTokInsightDailyUncheckedCreateInput[],
): Promise<Array<{ id: string; insightKey: string }>> {
  if (inputs.length === 0) return [];

  const now = new Date();
  const rows = inputs.map((input) => ({
    id: input.id ?? randomUUID(),
    insightKey: input.insightKey,
    advertiserDbId: input.advertiserDbId,
    campaignId: input.campaignId ?? null,
    adGroupId: input.adGroupId ?? null,
    adId: input.adId ?? null,
    level: input.level,
    metricLevel: metricLevel(input.level),
    date: iso(input.date),
    accountCurrency: input.accountCurrency ?? null,
    spend: decimal(input.spend) ?? '0',
    impressions: integer(input.impressions) ?? '0',
    reach: integer(input.reach),
    clicks: integer(input.clicks) ?? '0',
    ctr: decimal(input.ctr),
    cpc: decimal(input.cpc),
    cpm: decimal(input.cpm),
    frequency: decimal(input.frequency),
    conversions: decimal(input.conversions),
    conversionValue: decimal(input.conversionValue),
    costPerConversion: decimal(input.costPerConversion),
    roas: decimal(input.roas),
    resultCount: decimal(input.resultCount),
    costPerResult: decimal(input.costPerResult),
    videoPlayActions: integer(input.videoPlayActions),
    videoWatched2s: integer(input.videoWatched2s),
    videoWatched6s: integer(input.videoWatched6s),
    videoViewsP25: integer(input.videoViewsP25),
    videoViewsP50: integer(input.videoViewsP50),
    videoViewsP75: integer(input.videoViewsP75),
    videoViewsP100: integer(input.videoViewsP100),
    likes: integer(input.likes),
    comments: integer(input.comments),
    shares: integer(input.shares),
    follows: integer(input.follows),
    profileVisits: integer(input.profileVisits),
    objectiveType: input.objectiveType ?? null,
    optimizationGoal: input.optimizationGoal ?? null,
    attributionWindow: input.attributionWindow ?? null,
    dimensionsJson: input.dimensionsJson ?? null,
    metricsJson: input.metricsJson ?? null,
    rawJson: input.rawJson ?? null,
    providerMetrics: providerMetrics(input),
    syncedAt: iso(input.syncedAt, now),
    createdAt: iso(input.createdAt, now),
  }));

  const result = await db.$queryRaw<BulkResult[]>(Prisma.sql`
    WITH input AS (
      SELECT *
      FROM jsonb_to_recordset(${jsonPayload(rows)}::jsonb) AS row(
        id uuid,
        "insightKey" text,
        "advertiserDbId" uuid,
        "campaignId" uuid,
        "adGroupId" uuid,
        "adId" uuid,
        level text,
        "metricLevel" text,
        date date,
        "accountCurrency" text,
        spend numeric(20, 6),
        impressions bigint,
        reach bigint,
        clicks bigint,
        ctr numeric(20, 8),
        cpc numeric(20, 8),
        cpm numeric(20, 8),
        frequency numeric(20, 8),
        conversions numeric(20, 8),
        "conversionValue" numeric(20, 8),
        "costPerConversion" numeric(20, 8),
        roas numeric(20, 8),
        "resultCount" numeric(20, 8),
        "costPerResult" numeric(20, 8),
        "videoPlayActions" bigint,
        "videoWatched2s" bigint,
        "videoWatched6s" bigint,
        "videoViewsP25" bigint,
        "videoViewsP50" bigint,
        "videoViewsP75" bigint,
        "videoViewsP100" bigint,
        likes bigint,
        comments bigint,
        shares bigint,
        follows bigint,
        "profileVisits" bigint,
        "objectiveType" text,
        "optimizationGoal" text,
        "attributionWindow" text,
        "dimensionsJson" jsonb,
        "metricsJson" jsonb,
        "rawJson" jsonb,
        "providerMetrics" jsonb,
        "syncedAt" timestamp,
        "createdAt" timestamp
      )
    ),
    native AS (
      INSERT INTO "TikTokInsightDaily" (
        "id", "insightKey", "advertiserDbId", "campaignId", "adGroupId", "adId", "level",
        "date", "accountCurrency", "spend", "impressions", "reach", "clicks", "ctr", "cpc",
        "cpm", "frequency", "conversions", "conversionValue", "costPerConversion", "roas",
        "resultCount", "costPerResult", "videoPlayActions", "videoWatched2s", "videoWatched6s",
        "videoViewsP25", "videoViewsP50", "videoViewsP75", "videoViewsP100", "likes", "comments",
        "shares", "follows", "profileVisits", "objectiveType", "optimizationGoal", "attributionWindow",
        "dimensionsJson", "metricsJson", "rawJson", "syncedAt", "createdAt", "updatedAt"
      )
      SELECT
        input.id,
        input."insightKey",
        input."advertiserDbId",
        input."campaignId",
        input."adGroupId",
        input."adId",
        input.level::"TikTokInsightLevel",
        input.date,
        input."accountCurrency",
        input.spend,
        input.impressions,
        input.reach,
        input.clicks,
        input.ctr,
        input.cpc,
        input.cpm,
        input.frequency,
        input.conversions,
        input."conversionValue",
        input."costPerConversion",
        input.roas,
        input."resultCount",
        input."costPerResult",
        input."videoPlayActions",
        input."videoWatched2s",
        input."videoWatched6s",
        input."videoViewsP25",
        input."videoViewsP50",
        input."videoViewsP75",
        input."videoViewsP100",
        input.likes,
        input.comments,
        input.shares,
        input.follows,
        input."profileVisits",
        input."objectiveType",
        input."optimizationGoal",
        input."attributionWindow",
        input."dimensionsJson",
        input."metricsJson",
        input."rawJson",
        input."syncedAt",
        input."createdAt",
        CURRENT_TIMESTAMP
      FROM input
      ON CONFLICT ("insightKey") DO UPDATE SET
        "advertiserDbId" = EXCLUDED."advertiserDbId",
        "campaignId" = EXCLUDED."campaignId",
        "adGroupId" = EXCLUDED."adGroupId",
        "adId" = EXCLUDED."adId",
        "level" = EXCLUDED."level",
        "date" = EXCLUDED."date",
        "accountCurrency" = EXCLUDED."accountCurrency",
        "spend" = EXCLUDED."spend",
        "impressions" = EXCLUDED."impressions",
        "reach" = EXCLUDED."reach",
        "clicks" = EXCLUDED."clicks",
        "ctr" = EXCLUDED."ctr",
        "cpc" = EXCLUDED."cpc",
        "cpm" = EXCLUDED."cpm",
        "frequency" = EXCLUDED."frequency",
        "conversions" = EXCLUDED."conversions",
        "conversionValue" = EXCLUDED."conversionValue",
        "costPerConversion" = EXCLUDED."costPerConversion",
        "roas" = EXCLUDED."roas",
        "resultCount" = EXCLUDED."resultCount",
        "costPerResult" = EXCLUDED."costPerResult",
        "videoPlayActions" = EXCLUDED."videoPlayActions",
        "videoWatched2s" = EXCLUDED."videoWatched2s",
        "videoWatched6s" = EXCLUDED."videoWatched6s",
        "videoViewsP25" = EXCLUDED."videoViewsP25",
        "videoViewsP50" = EXCLUDED."videoViewsP50",
        "videoViewsP75" = EXCLUDED."videoViewsP75",
        "videoViewsP100" = EXCLUDED."videoViewsP100",
        "likes" = EXCLUDED."likes",
        "comments" = EXCLUDED."comments",
        "shares" = EXCLUDED."shares",
        "follows" = EXCLUDED."follows",
        "profileVisits" = EXCLUDED."profileVisits",
        "objectiveType" = EXCLUDED."objectiveType",
        "optimizationGoal" = EXCLUDED."optimizationGoal",
        "attributionWindow" = EXCLUDED."attributionWindow",
        "dimensionsJson" = EXCLUDED."dimensionsJson",
        "metricsJson" = EXCLUDED."metricsJson",
        "rawJson" = EXCLUDED."rawJson",
        "syncedAt" = EXCLUDED."syncedAt",
        "updatedAt" = CURRENT_TIMESTAMP
      RETURNING *
    ),
    canonical AS (
      INSERT INTO "AdvertisingDailyMetric" (
        "id", "metricKey", "accountId", "campaignId", "groupId", "adId", "creativeIdSnapshot",
        "level", "date", "currency", "spend", "impressions", "reach", "clicks", "conversions",
        "conversionValue", "ctr", "cpc", "cpm", "frequency", "cpa", "roas", "providerMetrics",
        "breakdownHash", "breakdownJson", "rawJson", "syncedAt", "createdAt", "updatedAt"
      )
      SELECT
        native."id",
        'TIKTOK:' || native."insightKey",
        native."advertiserDbId",
        native."campaignId",
        native."adGroupId",
        native."adId",
        NULL,
        input."metricLevel"::"AdvertisingMetricLevel",
        native."date",
        native."accountCurrency",
        native."spend",
        native."impressions",
        native."reach",
        native."clicks",
        native."conversions",
        native."conversionValue",
        native."ctr",
        native."cpc",
        native."cpm",
        native."frequency",
        native."costPerConversion",
        native."roas",
        input."providerMetrics",
        NULL,
        native."dimensionsJson",
        native."rawJson",
        native."syncedAt",
        input."createdAt",
        CURRENT_TIMESTAMP
      FROM native
      INNER JOIN input ON input."insightKey" = native."insightKey"
      ON CONFLICT ("metricKey") DO UPDATE SET
        "accountId" = EXCLUDED."accountId",
        "campaignId" = EXCLUDED."campaignId",
        "groupId" = EXCLUDED."groupId",
        "adId" = EXCLUDED."adId",
        "creativeIdSnapshot" = EXCLUDED."creativeIdSnapshot",
        "level" = EXCLUDED."level",
        "date" = EXCLUDED."date",
        "currency" = EXCLUDED."currency",
        "spend" = EXCLUDED."spend",
        "impressions" = EXCLUDED."impressions",
        "reach" = EXCLUDED."reach",
        "clicks" = EXCLUDED."clicks",
        "conversions" = EXCLUDED."conversions",
        "conversionValue" = EXCLUDED."conversionValue",
        "ctr" = EXCLUDED."ctr",
        "cpc" = EXCLUDED."cpc",
        "cpm" = EXCLUDED."cpm",
        "frequency" = EXCLUDED."frequency",
        "cpa" = EXCLUDED."cpa",
        "roas" = EXCLUDED."roas",
        "providerMetrics" = EXCLUDED."providerMetrics",
        "breakdownHash" = EXCLUDED."breakdownHash",
        "breakdownJson" = EXCLUDED."breakdownJson",
        "rawJson" = EXCLUDED."rawJson",
        "syncedAt" = EXCLUDED."syncedAt",
        "updatedAt" = CURRENT_TIMESTAMP
      RETURNING "metricKey"
    )
    SELECT native."id", native."insightKey" AS insight_key
    FROM native
    INNER JOIN canonical ON canonical."metricKey" = 'TIKTOK:' || native."insightKey"
    ORDER BY native."insightKey"
  `);

  return result.map((row) => ({ id: row.id, insightKey: row.insight_key }));
}
