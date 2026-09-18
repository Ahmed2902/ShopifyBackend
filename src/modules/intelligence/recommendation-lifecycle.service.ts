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

function lifecycleStorageUnavailable(error: unknown): boolean {
  if (!error || typeof error !== 'object') return false;
  const code = 'code' in error ? String(error.code) : '';
  return code === 'P2021' || code === 'P2022';
}

function decorateRecommendation(
  recommendation: RankedRecommendation,
  lifecycle?: { state: RecommendationLifecycleState; updatedAt: Date } | null,
) {
  const occurrenceKey = recommendationOccurrenceKey(recommendation);
  return {
    ...recommendation,
    ...recommendationDecision(recommendation),
    occurrenceKey,
    lifecycleState: lifecycle?.state ?? ('OPEN' as const),
    lifecycleUpdatedAt: lifecycle?.updatedAt ?? null,
  };
}

export class RecommendationLifecycleService {
  async attach(storeId: string, recommendations: RankedRecommendation[]) {
    const occurrenceKeys = recommendations.map(recommendationOccurrenceKey);
    let stored: Array<{
      occurrenceKey: string;
      state: RecommendationLifecycleState;
      updatedAt: Date;
    }> = [];

    if (occurrenceKeys.length > 0) {
      try {
        stored = await prisma.recommendationLifecycle.findMany({
          where: { storeId, occurrenceKey: { in: occurrenceKeys } },
          select: { occurrenceKey: true, state: true, updatedAt: true },
        });
      } catch (error) {
        // Lifecycle persistence is secondary state. A developer database that has not yet
        // applied the lifecycle migration must not make the deterministic decision feed 500.
        // We still surface the recommendations as OPEN; writes fail explicitly below until
        // the migration is applied.
        if (!lifecycleStorageUnavailable(error)) throw error;
      }
    }

    const storedByKey = new Map(stored.map((item) => [item.occurrenceKey, item]));
    return recommendations.map((recommendation) =>
      decorateRecommendation(
        recommendation,
        storedByKey.get(recommendationOccurrenceKey(recommendation)) ?? null,
      ),
    );
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

    try {
      return await prisma.recommendationLifecycle.upsert({
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
    } catch (error) {
      if (lifecycleStorageUnavailable(error)) {
        throw new AppError(
          'Recommendation lifecycle storage is not available. Apply the latest database migrations and retry.',
          503,
          'RECOMMENDATION_LIFECYCLE_UNAVAILABLE',
        );
      }
      throw error;
    }
  }
}

export const recommendationLifecycleService = new RecommendationLifecycleService();
