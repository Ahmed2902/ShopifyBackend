import { AppError } from '../../errors/app-error.js';
import type { UnifiedAdvertisingProviderFilter } from '../advertising/unified-advertising.schema.js';
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

const PROVIDER_FILTERS: readonly UnifiedAdvertisingProviderFilter[] = [
  'ALL',
  'META',
  'TIKTOK',
  'GOOGLE_ADS',
];
const OCCURRENCE_WINDOW_PATTERN =
  /:(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}\.\d{3}Z:(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type IssuedRecommendation = RecommendationOccurrenceInput & { occurrenceKey?: string };

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

function unavailableProviderScope(error: unknown): boolean {
  return (
    error instanceof AppError &&
    (error.code === 'PLAN_AD_CHANNEL_LIMIT' || error.code === 'PLAN_CHANNEL_SELECTION_REQUIRED')
  );
}

/**
 * Resolves the authoritative recommendation occurrences that may be mutated for one Store.
 * Legacy recommendations remain supported while unified decisions are validated through the same
 * deterministic read path that issued them. The caller still passes the resulting set to the one
 * lifecycle persistence service, so no duplicate lifecycle state store is introduced.
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
  ): Promise<RecommendationOccurrenceInput[]> {
    const legacySnapshot = await this.legacyReads.read(storeId, { fresh: false });
    const legacy = legacySnapshot.recommendations.slice(0, limit);
    if (containsOccurrence(legacy, occurrenceKey)) return legacy;

    const window = occurrenceWindow(occurrenceKey);
    for (const provider of PROVIDER_FILTERS) {
      try {
        const unified = await this.unifiedReads.read(storeId, {
          provider,
          days: 30,
          ...(window ?? {}),
        });
        const visible = unified.recommendations.slice(0, limit);
        if (containsOccurrence(visible, occurrenceKey)) {
          return [...legacy, ...visible];
        }
      } catch (error) {
        // An Essentials store can legitimately be barred from one provider scope. Skip only those
        // canonical entitlement errors; subscription/auth/data failures must remain visible.
        if (unavailableProviderScope(error)) continue;
        throw error;
      }
    }

    // RecommendationLifecycleService.setState performs the final exact-key check and returns the
    // established RECOMMENDATION_OCCURRENCE_NOT_FOUND response for fabricated/stale occurrences.
    return legacy;
  }
}

export const recommendationOccurrenceValidationService =
  new RecommendationOccurrenceValidationService();
