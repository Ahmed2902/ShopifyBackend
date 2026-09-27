import { intelligenceSnapshotCachedReads } from '../../lib/store-decision-cache.js';
import { intelligenceRuntimeService } from './intelligence.runtime.js';
import {
  presentRecommendation,
  recommendationInputsComplete,
} from './recommendation-presentation.js';
import type { IntelligenceService } from './intelligence.service.js';

/**
 * Shared cache/coalescing boundary for the expensive deterministic snapshot.
 *
 * Keep this outside the HTTP controller so other backend workspaces (notably Overview) reuse the
 * exact same cached/in-flight computation instead of bypassing the controller cache and repeating
 * the evidence queries.
 *
 * The rule engine keeps its internal ranking inputs, but public readers receive only findings whose
 * required data-quality checks pass. Confidence/evidence-quality grades stay internal.
 */
export class IntelligenceSnapshotReadService {
  constructor(private readonly service: IntelligenceService = intelligenceRuntimeService) {}

  read(storeId: string, options: { fresh?: boolean } = {}) {
    return intelligenceSnapshotCachedReads
      .run(
        storeId,
        () => this.service.snapshot(storeId),
        { fresh: options.fresh ?? false, versionScope: storeId },
      )
      .then((snapshot) => ({
        ...snapshot,
        recommendations: snapshot.recommendations
          .filter((recommendation) =>
            recommendationInputsComplete(recommendation, snapshot.dataQuality),
          )
          .map((recommendation) => presentRecommendation(recommendation)),
      }));
  }

  invalidate(storeId: string) {
    return intelligenceSnapshotCachedReads.invalidate(storeId);
  }
}

export const intelligenceSnapshotReadService = new IntelligenceSnapshotReadService();
