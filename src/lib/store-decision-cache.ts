import { CachedReadCoordinator, RedisJsonCache } from './redis-json-cache.js';

// Match the proven Systemly analytics cache window. Correctness does not depend on TTL expiry:
// successful Store mutations advance the Store generation, and explicit `fresh` reads do the same.
// The TTL is therefore only a bounded reuse window for unchanged analytical state.
const ANALYTICS_CACHE_TTL_SECONDS = 120;
const DASHBOARD_CACHE_TTL_SECONDS = 120;
const INTELLIGENCE_CACHE_TTL_SECONDS = 120;
const MAX_IN_FLIGHT_READS = 250;

/**
 * Shared Store-scoped read caches for expensive analytical/decision surfaces.
 *
 * These caches use Store-level generations. Any successful source-data mutation can therefore
 * advance the generation once per namespace without enumerating date-range/entity/page keys. Old
 * values and old in-flight writers are harmless because they remain under the previous generation.
 */
export const analyticsWorkspaceCachedReads = new CachedReadCoordinator(
  new RedisJsonCache('analytics:workspace:v2', ANALYTICS_CACHE_TTL_SECONDS),
  MAX_IN_FLIGHT_READS,
);

export const dashboardCachedReads = new CachedReadCoordinator(
  new RedisJsonCache('analytics:dashboard:v1', DASHBOARD_CACHE_TTL_SECONDS),
  MAX_IN_FLIGHT_READS,
);

export const intelligenceSnapshotCachedReads = new CachedReadCoordinator(
  new RedisJsonCache('intelligence:snapshot:v1', INTELLIGENCE_CACHE_TTL_SECONDS),
  MAX_IN_FLIGHT_READS,
);

export async function invalidateStoreDecisionCaches(storeId: string): Promise<void> {
  await Promise.all([
    analyticsWorkspaceCachedReads.invalidate(storeId),
    dashboardCachedReads.invalidate(storeId),
    intelligenceSnapshotCachedReads.invalidate(storeId),
  ]);
}
