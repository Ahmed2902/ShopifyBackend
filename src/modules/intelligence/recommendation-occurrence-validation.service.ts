import {
  intelligenceSnapshotReadService,
  type IntelligenceSnapshotReadService,
} from './intelligence-snapshot.read.service.js';
import {
  recommendationOccurrenceKey,
  type RecommendationOccurrenceInput,
} from './recommendation-lifecycle.service.js';
import {
  unifiedDecisionService,
  type UnifiedDecisionService,
} from './unified-decision.service.js';
import { parseScopedUnifiedRecommendationOccurrenceKey } from './unified-recommendation-occurrence-scope.js';

const OCCURRENCE_WINDOW_PATTERN =
  /:(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}\.\d{3}Z:(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type IssuedRecommendation = RecommendationOccurrenceInput & { occurrenceKey?: string };

export type RecommendationOccurrenceValidationResult = {
  canonicalOccurrenceKey: string;
  recommendations: RecommendationOccurrenceInput[];
};

function containsOccurrence(
  recommendations: readonly IssuedRecommendation[],
  occurrenceKey: string,
): boolean {
  return recommendations.some(
    (recommendation) =>
      recommendation.occurrenceKey === occurrenceKey ||
      recommendationOccurrenceKey(recommendation) === occurrenceKey,
  );
}

function occurrenceWindow(occurrenceKey: string) {
  const match = OCCURRENCE_WINDOW_PATTERN.exec(occurrenceKey);
  return match ? { from: match[1]!, to: match[2]! } : null;
}

/**
 * Resolves the authoritative recommendation occurrence that may be mutated for one Store.
 *
 * New unified HTTP responses carry their exact read scope in the public occurrence handle. The
 * validator replays exactly that one query through the normal unified service, so account,
 * arbitrary three-letter currency, provider and window semantics are preserved without an
 * exhaustive account/currency search. The canonical occurrence key is still what the single
 * RecommendationLifecycle persistence mechanism stores.
 *
 * Unscoped keys remain supported for legacy recommendations and for the pre-hotfix default unified
 * (`provider=ALL`) surface. They deliberately do not trigger unbounded scope guessing.
 */
export class RecommendationOccurrenceValidationService {
  constructor(
    private readonly legacyReads: IntelligenceSnapshotReadService = intelligenceSnapshotReadService,
    private readonly unifiedReads: UnifiedDecisionService = unifiedDecisionService,
  ) {}

  async currentRecommendations(
    storeId: string,
    occurrenceKey: string,
    limit: number,
  ): Promise<RecommendationOccurrenceValidationResult> {
    const legacySnapshot = await this.legacyReads.read(storeId, { fresh: false });
    const legacy = legacySnapshot.recommendations.slice(0, limit);
    if (containsOccurrence(legacy, occurrenceKey)) {
      return { canonicalOccurrenceKey: occurrenceKey, recommendations: legacy };
    }

    const scoped = parseScopedUnifiedRecommendationOccurrenceKey(occurrenceKey);
    if (scoped) {
      // The parsed scope is not authorization by itself. UnifiedDecisionService re-enters the
      // canonical store/provider/account entitlement boundary and the occurrence must still be
      // visible under the current plan before mutation is accepted.
      const unified = await this.unifiedReads.read(storeId, scoped.query);
      const visible = unified.recommendations.slice(0, limit);
      if (containsOccurrence(visible, scoped.canonicalOccurrenceKey)) {
        return {
          canonicalOccurrenceKey: scoped.canonicalOccurrenceKey,
          recommendations: [...legacy, ...visible],
        };
      }
      return { canonicalOccurrenceKey: scoped.canonicalOccurrenceKey, recommendations: legacy };
    }

    // Backward compatibility for pre-hotfix unified keys: one bounded default-scope replay only.
    // Scoped keys issued after this hotfix never reach this path.
    const window = occurrenceWindow(occurrenceKey);
    const unified = await this.unifiedReads.read(storeId, {
      days: 30,
      ...(window ?? {}),
      provider: 'ALL',
    });
    const visible = unified.recommendations.slice(0, limit);
    if (containsOccurrence(visible, occurrenceKey)) {
      return {
        canonicalOccurrenceKey: occurrenceKey,
        recommendations: [...legacy, ...visible],
      };
    }

    // RecommendationLifecycleService.setState performs the final exact-key check and returns the
    // established RECOMMENDATION_OCCURRENCE_NOT_FOUND response for fabricated/stale occurrences.
    return { canonicalOccurrenceKey: occurrenceKey, recommendations: legacy };
  }
}

export const recommendationOccurrenceValidationService =
  new RecommendationOccurrenceValidationService();
