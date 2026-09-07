import { CachedReadCoordinator, RedisJsonCache } from '../../lib/redis-json-cache.js';
import { intelligenceService, type IntelligenceService } from './intelligence.service.js';

const SNAPSHOT_CACHE_TTL_SECONDS = 30;

/**
 * Shared cache/coalescing boundary for the expensive deterministic snapshot.
 *
 * Keep this outside the HTTP controller so other backend workspaces (notably Overview) reuse the
 * exact same cached/in-flight computation instead of bypassing the controller cache and repeating
 * the evidence queries.
 */
export class IntelligenceSnapshotReadService {
  private readonly reads = new CachedReadCoordinator(
    new RedisJsonCache('intelligence:snapshot:v1', SNAPSHOT_CACHE_TTL_SECONDS),
    250,
  );

  constructor(private readonly service: IntelligenceService = intelligenceService) {}

  read(storeId: string, options: { fresh?: boolean } = {}) {
    return this.reads.run(
      storeId,
      () => this.service.snapshot(storeId),
      { fresh: options.fresh ?? false },
    );
  }

  invalidate(storeId: string) {
    return this.reads.invalidate(storeId);
  }
}

export const intelligenceSnapshotReadService = new IntelligenceSnapshotReadService();
