import { intelligenceSnapshotCachedReads } from '../../lib/store-decision-cache.js';
import { intelligenceService, type IntelligenceService } from './intelligence.service.js';
import { merchantInventoryRiskService } from './merchant-inventory-risk.service.js';

/**
 * Shared cache/coalescing boundary for the expensive deterministic snapshot.
 *
 * Keep this outside the HTTP controller so other backend workspaces (notably Overview) reuse the
 * exact same cached/in-flight computation instead of bypassing the controller cache and repeating
 * the evidence queries.
 */
export class IntelligenceSnapshotReadService {
  constructor(private readonly service: IntelligenceService = intelligenceService) {}

  read(storeId: string, options: { fresh?: boolean } = {}) {
    return intelligenceSnapshotCachedReads.run(
      storeId,
      async () => {
        const [snapshot, merchantInventoryRisk] = await Promise.all([
          this.service.snapshot(storeId),
          merchantInventoryRiskService.recommendations(storeId),
        ]);
        const recommendations = [
          ...snapshot.recommendations.filter((item) => item.ruleId !== 'inventory_runway_risk'),
          ...merchantInventoryRisk,
        ].sort((left, right) => right.priority - left.priority);
        return { ...snapshot, recommendations };
      },
      { fresh: options.fresh ?? false, versionScope: storeId },
    );
  }

  invalidate(storeId: string) {
    return intelligenceSnapshotCachedReads.invalidate(storeId);
  }
}

export const intelligenceSnapshotReadService = new IntelligenceSnapshotReadService();
