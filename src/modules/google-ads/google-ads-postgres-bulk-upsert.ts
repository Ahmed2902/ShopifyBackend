import { Prisma } from '../../generated/prisma/client.js';

export type GoogleAdsBulkClient = Pick<Prisma.TransactionClient, '$executeRaw'>;

export const GOOGLE_ADS_BULK_BATCH_SIZE = 500;

export interface GoogleAdsBulkAdInput {
  id: string;
  accountId: string;
  campaignId: string;
  groupId: string | null;
  providerEntityId: string;
  name: string;
  status: string | null;
  effectiveStatus: string | null;
  format: string | null;
  landingPageUrl: string | null;
  providerData: unknown;
  rawJson: unknown;
  deletedAt: Date | null;
}

export interface GoogleAdsBulkCreativeInput {
  id: string;
  accountId: string;
  providerEntityId: string;
  name: string | null;
  title: string | null;
  imageUrl: string | null;
  videoId: string | null;
  providerData: unknown;
  rawJson: unknown;
  deletedAt: Date | null;
}

export interface GoogleAdsBulkMetricInput {
  id: string;
  metricKey: string;
  accountId: string;
  campaignId: string | null;
  groupId: string | null;
  adId: string | null;
  level: 'ACCOUNT' | 'CAMPAIGN' | 'GROUP' | 'ASSET_GROUP' | 'AD';
  date: Date;
  currency: string | null;
  spend: string;
  impressions: string;
  clicks: string;
  conversions: string | null;
  conversionValue: string | null;
  ctr: string | null;
  cpc: string | null;
  cpm: string | null;
  cpa: string | null;
  roas: string | null;
  providerMetrics: unknown;
  rawJson: unknown;
}

function payload(value: unknown): string {
  return JSON.stringify(value, (_key, item) => {
    if (typeof item === 'bigint') return item.toString();
    if (item instanceof Prisma.Decimal) return item.toString();
    return item;
  });
}

function batches<T>(rows: T[], size = GOOGLE_ADS_BULK_BATCH_SIZE): T[][] {
  const result: T[][] = [];
  for (let offset = 0; offset < rows.length; offset += size) {
    result.push(rows.slice(offset, offset + size));
  }
  return result;
}

export async function bulkUpsertGoogleAds(
  db: GoogleAdsBulkClient,
  input: {
    ads?: GoogleAdsBulkAdInput[];
    creatives?: GoogleAdsBulkCreativeInput[];
    metrics?: GoogleAdsBulkMetricInput[];
  },
): Promise<{ dbOperations: number }> {
  let dbOperations = 0;

  for (const rows of batches(input.ads ?? [])) {
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "AdvertisingAd" (
        "id", "accountId", "campaignId", "groupId", "providerEntityId", "name", "status",
        "effectiveStatus", "format", "landingPageUrl", "providerData", "rawJson", "deletedAt",
        "createdAt", "updatedAt"
      )
      SELECT
        row.id, row."accountId", row."campaignId", row."groupId", row."providerEntityId", row.name,
        row.status, row."effectiveStatus", row.format, row."landingPageUrl", row."providerData",
        row."rawJson", row."deletedAt", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM jsonb_to_recordset(${payload(rows)}::jsonb) AS row(
        id uuid,
        "accountId" uuid,
        "campaignId" uuid,
        "groupId" uuid,
        "providerEntityId" text,
        name text,
        status text,
        "effectiveStatus" text,
        format text,
        "landingPageUrl" text,
        "providerData" jsonb,
        "rawJson" jsonb,
        "deletedAt" timestamp
      )
      ON CONFLICT ("id") DO UPDATE SET
        "accountId" = EXCLUDED."accountId",
        "campaignId" = EXCLUDED."campaignId",
        "groupId" = EXCLUDED."groupId",
        "providerEntityId" = EXCLUDED."providerEntityId",
        "name" = EXCLUDED."name",
        "status" = EXCLUDED."status",
        "effectiveStatus" = EXCLUDED."effectiveStatus",
        "format" = EXCLUDED."format",
        "landingPageUrl" = EXCLUDED."landingPageUrl",
        "providerData" = EXCLUDED."providerData",
        "rawJson" = EXCLUDED."rawJson",
        "deletedAt" = EXCLUDED."deletedAt",
        "updatedAt" = CURRENT_TIMESTAMP
    `);
    dbOperations += 1;
  }

  for (const rows of batches(input.creatives ?? [])) {
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "AdvertisingCreative" (
        "id", "accountId", "providerEntityId", "name", "title", "imageUrl", "videoId",
        "providerData", "rawJson", "deletedAt", "createdAt", "updatedAt"
      )
      SELECT
        row.id, row."accountId", row."providerEntityId", row.name, row.title, row."imageUrl",
        row."videoId", row."providerData", row."rawJson", row."deletedAt",
        CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
      FROM jsonb_to_recordset(${payload(rows)}::jsonb) AS row(
        id uuid,
        "accountId" uuid,
        "providerEntityId" text,
        name text,
        title text,
        "imageUrl" text,
        "videoId" text,
        "providerData" jsonb,
        "rawJson" jsonb,
        "deletedAt" timestamp
      )
      ON CONFLICT ("id") DO UPDATE SET
        "accountId" = EXCLUDED."accountId",
        "providerEntityId" = EXCLUDED."providerEntityId",
        "name" = EXCLUDED."name",
        "title" = EXCLUDED."title",
        "imageUrl" = EXCLUDED."imageUrl",
        "videoId" = EXCLUDED."videoId",
        "providerData" = EXCLUDED."providerData",
        "rawJson" = EXCLUDED."rawJson",
        "deletedAt" = EXCLUDED."deletedAt",
        "updatedAt" = CURRENT_TIMESTAMP
    `);
    dbOperations += 1;
  }

  for (const rows of batches(input.metrics ?? [])) {
    await db.$executeRaw(Prisma.sql`
      INSERT INTO "AdvertisingDailyMetric" (
        "id", "metricKey", "accountId", "campaignId", "groupId", "adId", "level", "date",
        "currency", "spend", "impressions", "clicks", "conversions", "conversionValue", "ctr",
        "cpc", "cpm", "cpa", "roas", "providerMetrics", "rawJson", "syncedAt", "createdAt",
        "updatedAt"
      )
      SELECT
        row.id, row."metricKey", row."accountId", row."campaignId", row."groupId", row."adId",
        row.level::"AdvertisingMetricLevel", row.date, row.currency, row.spend, row.impressions,
        row.clicks, row.conversions, row."conversionValue", row.ctr, row.cpc, row.cpm, row.cpa,
        row.roas, row."providerMetrics", row."rawJson", CURRENT_TIMESTAMP, CURRENT_TIMESTAMP,
        CURRENT_TIMESTAMP
      FROM jsonb_to_recordset(${payload(rows)}::jsonb) AS row(
        id uuid,
        "metricKey" text,
        "accountId" uuid,
        "campaignId" uuid,
        "groupId" uuid,
        "adId" uuid,
        level text,
        date date,
        currency text,
        spend numeric(20, 6),
        impressions bigint,
        clicks bigint,
        conversions numeric(20, 8),
        "conversionValue" numeric(20, 8),
        ctr numeric(20, 8),
        cpc numeric(20, 8),
        cpm numeric(20, 8),
        cpa numeric(20, 8),
        roas numeric(20, 8),
        "providerMetrics" jsonb,
        "rawJson" jsonb
      )
      ON CONFLICT ("metricKey") DO UPDATE SET
        "accountId" = EXCLUDED."accountId",
        "campaignId" = EXCLUDED."campaignId",
        "groupId" = EXCLUDED."groupId",
        "adId" = EXCLUDED."adId",
        "level" = EXCLUDED."level",
        "date" = EXCLUDED."date",
        "currency" = EXCLUDED."currency",
        "spend" = EXCLUDED."spend",
        "impressions" = EXCLUDED."impressions",
        "clicks" = EXCLUDED."clicks",
        "conversions" = EXCLUDED."conversions",
        "conversionValue" = EXCLUDED."conversionValue",
        "ctr" = EXCLUDED."ctr",
        "cpc" = EXCLUDED."cpc",
        "cpm" = EXCLUDED."cpm",
        "cpa" = EXCLUDED."cpa",
        "roas" = EXCLUDED."roas",
        "providerMetrics" = EXCLUDED."providerMetrics",
        "rawJson" = EXCLUDED."rawJson",
        "syncedAt" = CURRENT_TIMESTAMP,
        "updatedAt" = CURRENT_TIMESTAMP
    `);
    dbOperations += 1;
  }

  return { dbOperations };
}
