import { AppError } from '../../errors/app-error.js';
import { prisma } from '../../lib/prisma.js';
import { recommendationDecision } from './recommendation-decision.js';
import type {
  RecommendationDraft,
  RecommendationLifecycleState,
} from './intelligence.types.js';

type RankedRecommendation = RecommendationDraft & { priority: number };
export type RecommendationOccurrenceInput = Pick<
  RecommendationDraft,
  | 'ruleId'
  | 'ruleVersion'
  | 'entityType'
  | 'entityId'
  | 'externalEntityId'
  | 'title'
> & {
  observationStart: Date | string;
  observationEnd: Date | string;
};

function occurrenceTimestamp(value: Date | string): string {
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

export function recommendationOccurrenceKey(
  recommendation: RecommendationOccurrenceInput,
): string {
  const entity =
    recommendation.entityId ?? recommendation.externalEntityId ?? recommendation.title;
  return [
    recommendation.ruleId,
    recommendation.ruleVersion,
    recommendation.entityType,
    entity,
    occurrenceTimestamp(recommendation.observationStart),
    occurrenceTimestamp(recommendation.observationEnd),
  ].join(':');
}

function transitionTimestamps(state: RecommendationLifecycleState, now: Date) {
  switch (state) {
    case 'REVIEWED':
      return { reviewedAt: now };
    case 'DISMISSED':
      return { dismissedAt: now };
    case 'RESOLVED':
      return { resolvedAt: now };
    case 'OPEN':
      return { reopenedAt: now };
  }
}

export class RecommendationLifecycleService {
  async attach(storeId: string, recommendations: RankedRecommendation[]) {
    const occurrenceKeys = recommendations.map(recommendationOccurrenceKey);
    const stored =
      occurrenceKeys.length === 0
        ? []
        : await prisma.recommendationLifecycle.findMany({
            where: { storeId, occurrenceKey: { in: occurrenceKeys } },
            select: { occurrenceKey: true, state: true, updatedAt: true },
          });
    const storedByKey = new Map(stored.map((item) => [item.occurrenceKey, item]));

    return recommendations.map((recommendation) => {
      const occurrenceKey = recommendationOccurrenceKey(recommendation);
      const lifecycle = storedByKey.get(occurrenceKey);
      return {
        ...recommendation,
        ...recommendationDecision(recommendation),
        occurrenceKey,
        lifecycleState: lifecycle?.state ?? ('OPEN' as const),
        lifecycleUpdatedAt: lifecycle?.updatedAt ?? null,
      };
    });
  }

  async setState(
    storeId: string,
    occurrenceKey: string,
    state: RecommendationLifecycleState,
    currentRecommendations: RecommendationOccurrenceInput[],
  ) {
    const issuedForCurrentRecommendation = currentRecommendations.some(
      (recommendation) => recommendationOccurrenceKey(recommendation) === occurrenceKey,
    );
    if (!issuedForCurrentRecommendation) {
      throw new AppError(
        'Recommendation occurrence is not available in the current evidence window.',
        404,
        'RECOMMENDATION_OCCURRENCE_NOT_FOUND',
      );
    }

    const now = new Date();
    const timestamps = transitionTimestamps(state, now);

    return prisma.recommendationLifecycle.upsert({
      where: { storeId_occurrenceKey: { storeId, occurrenceKey } },
      create: { storeId, occurrenceKey, state, ...timestamps },
      update: { state, ...timestamps },
      select: {
        occurrenceKey: true,
        state: true,
        reviewedAt: true,
        dismissedAt: true,
        resolvedAt: true,
        reopenedAt: true,
        updatedAt: true,
      },
    });
  }
}

export const recommendationLifecycleService = new RecommendationLifecycleService();
