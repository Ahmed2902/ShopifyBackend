import { Prisma } from '../../../generated/prisma/client.js';
import { AppError } from '../../../errors/app-error.js';
import { prisma } from '../../../lib/prisma.js';
import { resolveAnalyticsWindows } from '../../analytics/analytics.dates.js';
import type { AnalyticsRangeQuery } from '../../analytics/analytics.schema.js';

type RawSourceRow = {
  source: string;
  session_count: bigint | number | null;
};

export class PixelBehaviorSourceReadService {
  product(storeId: string, productId: string, query: AnalyticsRangeQuery, now = new Date()) {
    return this.read(storeId, 'PRODUCT', productId, query, now);
  }

  collection(storeId: string, collectionId: string, query: AnalyticsRangeQuery, now = new Date()) {
    return this.read(storeId, 'COLLECTION', collectionId, query, now);
  }

  private async read(
    storeId: string,
    dimension: 'PRODUCT' | 'COLLECTION',
    entityId: string,
    query: AnalyticsRangeQuery,
    now: Date,
  ) {
    const store = await prisma.store.findUnique({
      where: { id: storeId },
      select: { id: true, ianaTimezone: true },
    });
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    const windows = resolveAnalyticsWindows(query, store.ianaTimezone, now);
    const join = dimension === 'PRODUCT'
      ? Prisma.sql`INNER JOIN "StorefrontSessionProduct" entity ON entity."sessionId" = session."id" AND entity."productId" = ${entityId}::uuid`
      : Prisma.sql`INNER JOIN "StorefrontSessionCollection" entity ON entity."sessionId" = session."id" AND entity."collectionId" = ${entityId}::uuid`;

    const rows = await prisma.$queryRaw<RawSourceRow[]>(Prisma.sql`
      WITH entity_sessions AS MATERIALIZED (
        SELECT DISTINCT
          session."id" AS session_id,
          touch."source"::text AS raw_source,
          LOWER(COALESCE(touch."utmSource", '')) AS utm_source,
          LOWER(COALESCE(touch."utmMedium", '')) AS utm_medium,
          LOWER(COALESCE(touch."referrerUrl", '')) AS referrer_url
        FROM "StorefrontSession" session
        ${join}
        LEFT JOIN "StorefrontSessionTouch" touch
          ON touch."sessionId" = session."id"
         AND touch."ordinal" = 1
        WHERE session."storeId" = ${storeId}::uuid
          AND session."eventCount" > 0
          AND session."startedAt" BETWEEN ${windows.current.instantFrom} AND ${windows.current.instantTo}
      ), classified AS (
        SELECT
          session_id,
          CASE
            WHEN raw_source = 'META' THEN CASE
              WHEN utm_source IN ('instagram', 'ig', 'instagram.com') OR referrer_url LIKE '%instagram.com%' THEN 'INSTAGRAM'
              WHEN utm_source IN ('facebook', 'fb', 'facebook.com', 'fb.com') OR referrer_url LIKE '%facebook.com%' OR referrer_url LIKE '%fb.com%' THEN 'FACEBOOK'
              ELSE 'META'
            END
            WHEN raw_source = 'UTM'
              AND (utm_medium IN ('cpc', 'ppc', 'paid_social', 'paid-social', 'paidsocial') OR utm_medium LIKE '%paid%')
              THEN CASE
                WHEN utm_source IN ('instagram', 'ig', 'instagram.com') THEN 'INSTAGRAM'
                WHEN utm_source IN ('facebook', 'fb', 'facebook.com', 'fb.com') THEN 'FACEBOOK'
                WHEN utm_source IN ('meta', 'meta.com') THEN 'META'
                WHEN utm_source IN ('google', 'googleads', 'google_ads', 'adwords') THEN 'GOOGLE'
                WHEN utm_source IN ('tiktok', 'tik_tok', 'tiktok.com') THEN 'TIKTOK'
                ELSE 'UTM'
              END
            ELSE COALESCE(raw_source, 'UNKNOWN')
          END AS source
        FROM entity_sessions
      )
      SELECT source, COUNT(DISTINCT session_id) AS session_count
      FROM classified
      GROUP BY source
      ORDER BY session_count DESC, source ASC
    `);

    return {
      window: {
        current: {
          from: windows.current.fromDate,
          to: windows.current.toDate,
        },
      },
      dimension,
      entityId,
      methodology: 'FIRST_TOUCH_SOURCE_AMONG_SESSIONS_WITH_ENTITY_INTERACTION',
      items: rows.map((row) => ({ source: row.source, sessions: Number(row.session_count ?? 0) })),
    };
  }
}

export const pixelBehaviorSourceReadService = new PixelBehaviorSourceReadService();
