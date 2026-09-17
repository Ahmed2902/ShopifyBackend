import { intelligenceSnapshotCachedReads } from '../../lib/store-decision-cache.js';
import { intelligenceService, type IntelligenceService } from './intelligence.service.js';
import {
  storefrontIntelligenceService,
  type StorefrontIntelligenceService,
} from './storefront-intelligence.service.js';
import type { RecommendationDraft } from './intelligence.types.js';

function priority(recommendation: RecommendationDraft): number {
  return recommendation.impactScore * recommendation.confidenceScore * recommendation.urgencyScore;
}

/**
 * Shared cache/coalescing boundary for the expensive deterministic snapshot.
 *
 * Keep this outside the HTTP controller so other backend workspaces (notably Overview) reuse the
 * exact same cached/in-flight computation instead of bypassing the controller cache and repeating
 * the evidence queries.
 */
export class IntelligenceSnapshotReadService {
  constructor(
    private readonly service: IntelligenceService = intelligenceService,
    private readonly storefront: StorefrontIntelligenceService = storefrontIntelligenceService,
  ) {}

  read(storeId: string, options: { fresh?: boolean } = {}) {
    return intelligenceSnapshotCachedReads.run(
      storeId,
      async () => {
        const core = await this.service.snapshot(storeId);
        const storefront = await this.storefront.evaluate(storeId, core.windows.decision);
        const storefrontRecommendations = storefront.recommendations.map((recommendation) => ({
          ...recommendation,
          priority: priority(recommendation),
        }));
        const dataQuality = storefront.dataQuality.length
          ? [
              ...core.dataQuality.filter((item) => item.code !== 'CORE_DATA_HEALTHY'),
              ...storefront.dataQuality,
            ]
          : core.dataQuality;

        return {
          ...core,
          evidence: {
            ...core.evidence,
            storefront: storefront.evidence,
          },
          recommendations: [...core.recommendations, ...storefrontRecommendations].sort(
            (left, right) => right.priority - left.priority,
          ),
          dataQuality,
        };
      },
      { fresh: options.fresh ?? false, versionScope: storeId },
    );
  }

  invalidate(storeId: string) {
    return intelligenceSnapshotCachedReads.invalidate(storeId);
  }
}

export const intelligenceSnapshotReadService = new IntelligenceSnapshotReadService();
