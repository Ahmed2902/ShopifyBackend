import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';

type RawPixelHealthRow = {
  installation_status: string | null;
  installation_last_event_at: Date | null;
  installation_last_error: string | null;
  accepted_events_24h: bigint | number;
  last_accepted_event_at: Date | null;
  pending_repairs: bigint | number;
  oldest_repair_at: Date | null;
  pending_order_links: bigint | number;
  oldest_pending_order_at: Date | null;
  behavior_dirty_sessions: bigint | number;
  behavior_oldest_dirty_at: Date | null;
  behavior_last_rolled_up_at: Date | null;
  behavior_last_error: string | null;
  attribution_dirty_sessions: bigint | number;
  attribution_oldest_dirty_at: Date | null;
  attribution_last_rolled_up_at: Date | null;
  attribution_last_error: string | null;
  expired_events_pending_cleanup: bigint | number;
  oldest_expired_event_at: Date | null;
  expired_sessions_pending_cleanup: bigint | number;
  oldest_expired_session_at: Date | null;
};

export type PixelOperationalHealthRow = {
  installationStatus: string | null;
  installationLastEventAt: Date | null;
  installationLastError: string | null;
  acceptedEvents24h: number;
  lastAcceptedEventAt: Date | null;
  pendingRepairs: number;
  oldestRepairAt: Date | null;
  pendingOrderLinks: number;
  oldestPendingOrderAt: Date | null;
  behaviorDirtySessions: number;
  behaviorOldestDirtyAt: Date | null;
  behaviorLastRolledUpAt: Date | null;
  behaviorLastError: string | null;
  attributionDirtySessions: number;
  attributionOldestDirtyAt: Date | null;
  attributionLastRolledUpAt: Date | null;
  attributionLastError: string | null;
  expiredEventsPendingCleanup: number;
  oldestExpiredEventAt: Date | null;
  expiredSessionsPendingCleanup: number;
  oldestExpiredSessionAt: Date | null;
};

function count(value: bigint | number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

/**
 * One bounded PostgreSQL read for the operational state already maintained by the Pixel workers.
 * This endpoint is diagnostic/admin traffic, but keeping the snapshot in one round trip makes it
 * cheap enough to inspect repeatedly during rollout without creating a new observability store.
 */
export class PixelHealthRepository {
  async read(storeId: string, now: Date): Promise<PixelOperationalHealthRow | null> {
    const since = new Date(now.getTime() - 24 * 60 * 60_000);
    const rows = await prisma.$queryRaw<RawPixelHealthRow[]>(Prisma.sql`
      SELECT
        installation."status"::text AS installation_status,
        installation."lastEventAt" AS installation_last_event_at,
        installation."lastError" AS installation_last_error,
        COALESCE(events.accepted_events_24h, 0) AS accepted_events_24h,
        events.last_accepted_event_at,
        COALESCE(repairs.pending_repairs, 0) AS pending_repairs,
        repairs.oldest_repair_at,
        COALESCE(order_links.pending_order_links, 0) AS pending_order_links,
        order_links.oldest_pending_order_at,
        COALESCE(behavior_dirty.dirty_sessions, 0) AS behavior_dirty_sessions,
        behavior_dirty.oldest_dirty_at AS behavior_oldest_dirty_at,
        behavior_state."lastRolledUpAt" AS behavior_last_rolled_up_at,
        behavior_state."lastError" AS behavior_last_error,
        COALESCE(attribution_dirty.dirty_sessions, 0) AS attribution_dirty_sessions,
        attribution_dirty.oldest_dirty_at AS attribution_oldest_dirty_at,
        attribution_state."lastRolledUpAt" AS attribution_last_rolled_up_at,
        attribution_state."lastError" AS attribution_last_error,
        COALESCE(retention.expired_events, 0) AS expired_events_pending_cleanup,
        retention.oldest_expired_event_at,
        COALESCE(retention.expired_sessions, 0) AS expired_sessions_pending_cleanup,
        retention.oldest_expired_session_at
      FROM "Store" store
      LEFT JOIN "PixelInstallation" installation
        ON installation."storeId" = store."id"
      LEFT JOIN "StorefrontBehaviorRollupState" behavior_state
        ON behavior_state."storeId" = store."id"
      LEFT JOIN "StorefrontAttributionRollupState" attribution_state
        ON attribution_state."storeId" = store."id"
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::bigint AS accepted_events_24h,
          MAX(event."receivedAt") AS last_accepted_event_at
        FROM "StorefrontEvent" event
        WHERE event."storeId" = store."id"
          AND event."receivedAt" >= ${since}
      ) events ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::bigint AS pending_repairs,
          MIN(repair."sourceReceivedAt") AS oldest_repair_at
        FROM "StorefrontSessionRepair" repair
        WHERE repair."storeId" = store."id"
      ) repairs ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::bigint AS pending_order_links,
          MIN(COALESCE(session."checkoutCompletedAt", session."updatedAt")) AS oldest_pending_order_at
        FROM "StorefrontSession" session
        WHERE session."storeId" = store."id"
          AND session."orderLinkStatus" = 'PENDING'
      ) order_links ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::bigint AS dirty_sessions,
          MIN(session."rollupDirtyAt") AS oldest_dirty_at
        FROM "StorefrontSession" session
        WHERE session."storeId" = store."id"
          AND (
            session."behaviorRolledUpAt" IS NULL
            OR session."rollupDirtyAt" > session."behaviorRolledUpAt"
          )
      ) behavior_dirty ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*)::bigint AS dirty_sessions,
          MIN(session."rollupDirtyAt") AS oldest_dirty_at
        FROM "StorefrontSession" session
        WHERE session."storeId" = store."id"
          AND (
            session."attributionRolledUpAt" IS NULL
            OR session."rollupDirtyAt" > session."attributionRolledUpAt"
          )
      ) attribution_dirty ON TRUE
      LEFT JOIN LATERAL (
        SELECT
          COUNT(*) FILTER (WHERE event."retentionExpiresAt" <= ${now})::bigint AS expired_events,
          MIN(event."retentionExpiresAt") FILTER (
            WHERE event."retentionExpiresAt" <= ${now}
          ) AS oldest_expired_event_at,
          (
            SELECT COUNT(*)::bigint
            FROM "StorefrontSession" expired_session
            WHERE expired_session."storeId" = store."id"
              AND expired_session."retentionExpiresAt" <= ${now}
          ) AS expired_sessions,
          (
            SELECT MIN(expired_session."retentionExpiresAt")
            FROM "StorefrontSession" expired_session
            WHERE expired_session."storeId" = store."id"
              AND expired_session."retentionExpiresAt" <= ${now}
          ) AS oldest_expired_session_at
        FROM "StorefrontEvent" event
        WHERE event."storeId" = store."id"
      ) retention ON TRUE
      WHERE store."id" = ${storeId}::uuid
      LIMIT 1
    `);

    const row = rows[0];
    if (!row) return null;
    return {
      installationStatus: row.installation_status,
      installationLastEventAt: row.installation_last_event_at,
      installationLastError: row.installation_last_error,
      acceptedEvents24h: count(row.accepted_events_24h),
      lastAcceptedEventAt: row.last_accepted_event_at,
      pendingRepairs: count(row.pending_repairs),
      oldestRepairAt: row.oldest_repair_at,
      pendingOrderLinks: count(row.pending_order_links),
      oldestPendingOrderAt: row.oldest_pending_order_at,
      behaviorDirtySessions: count(row.behavior_dirty_sessions),
      behaviorOldestDirtyAt: row.behavior_oldest_dirty_at,
      behaviorLastRolledUpAt: row.behavior_last_rolled_up_at,
      behaviorLastError: row.behavior_last_error,
      attributionDirtySessions: count(row.attribution_dirty_sessions),
      attributionOldestDirtyAt: row.attribution_oldest_dirty_at,
      attributionLastRolledUpAt: row.attribution_last_rolled_up_at,
      attributionLastError: row.attribution_last_error,
      expiredEventsPendingCleanup: count(row.expired_events_pending_cleanup),
      oldestExpiredEventAt: row.oldest_expired_event_at,
      expiredSessionsPendingCleanup: count(row.expired_sessions_pending_cleanup),
      oldestExpiredSessionAt: row.oldest_expired_session_at,
    };
  }
}
