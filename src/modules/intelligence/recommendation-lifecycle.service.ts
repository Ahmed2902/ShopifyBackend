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

function entityKey(type: RecommendationDraft['entityType'], id: string) {
  return `${type}:${id}`;
}

async function loadEntityNames(storeId: string, recommendations: RankedRecommendation[]) {
  const ids = {
    campaigns: new Set<string>(),
    adSets: new Set<string>(),
    ads: new Set<string>(),
    creatives: new Set<string>(),
    products: new Set<string>(),
    collections: new Set<string>(),
  };

  for (const recommendation of recommendations) {
    if (!recommendation.entityId || recommendation.entityName) continue;
    if (recommendation.entityType === 'CAMPAIGN') ids.campaigns.add(recommendation.entityId);
    else if (recommendation.entityType === 'AD_SET') ids.adSets.add(recommendation.entityId);
    else if (recommendation.entityType === 'AD') ids.ads.add(recommendation.entityId);
    else if (recommendation.entityType === 'CREATIVE') ids.creatives.add(recommendation.entityId);
    else if (recommendation.entityType === 'PRODUCT') ids.products.add(recommendation.entityId);
    else if (recommendation.entityType === 'COLLECTION') ids.collections.add(recommendation.entityId);
  }

  const [campaigns, adSets, ads, creatives, products, collections] = await Promise.all([
    ids.campaigns.size
      ? prisma.advertisingCampaign.findMany({
          where: {
            id: { in: [...ids.campaigns] },
            account: { storeId, provider: 'META' },
          },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    ids.adSets.size
      ? prisma.advertisingGroup.findMany({
          where: {
            id: { in: [...ids.adSets] },
            kind: 'AD_SET',
            account: { storeId, provider: 'META' },
          },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    ids.ads.size
      ? prisma.advertisingAd.findMany({
          where: {
            id: { in: [...ids.ads] },
            account: { storeId, provider: 'META' },
          },
          select: { id: true, name: true },
        })
      : Promise.resolve([]),
    ids.creatives.size
      ? prisma.advertisingCreative.findMany({
          where: {
            id: { in: [...ids.creatives] },
            account: { storeId, provider: 'META' },
          },
          select: { id: true, name: true, title: true },
        })
      : Promise.resolve([]),
    ids.products.size
      ? prisma.product.findMany({
          where: { id: { in: [...ids.products] }, storeId, deletedAt: null },
          select: { id: true, title: true },
        })
      : Promise.resolve([]),
    ids.collections.size
      ? prisma.collection.findMany({
          where: { id: { in: [...ids.collections] }, storeId, deletedAt: null },
          select: { id: true, title: true },
        })
      : Promise.resolve([]),
  ]);

  const names = new Map<string, string>();
  for (const item of campaigns) names.set(entityKey('CAMPAIGN', item.id), item.name);
  for (const item of adSets) names.set(entityKey('AD_SET', item.id), item.name);
  for (const item of ads) names.set(entityKey('AD', item.id), item.name);
  for (const item of creatives) {
    names.set(entityKey('CREATIVE', item.id), item.title ?? item.name ?? `Creative ${item.id}`);
  }
  for (const item of products) names.set(entityKey('PRODUCT', item.id), item.title);
  for (const item of collections) names.set(entityKey('COLLECTION', item.id), item.title);
  return names;
}

function decorateRecommendation(
  recommendation: RankedRecommendation,
  lifecycle: { state: RecommendationLifecycleState; updatedAt: Date } | null | undefined,
  entityName: string | null,
) {
  const occurrenceKey = recommendationOccurrenceKey(recommendation);
  return {
    ...recommendation,
    entityName: recommendation.entityName ?? entityName,
    ...recommendationDecision(recommendation),
    occurrenceKey,
    lifecycleState: lifecycle?.state ?? ('OPEN' as const),
    lifecycleUpdatedAt: lifecycle?.updatedAt ?? null,
  };
}

export class RecommendationLifecycleService {
  async attach(storeId: string, recommendations: RankedRecommendation[]) {
    const occurrenceKeys = recommendations.map(recommendationOccurrenceKey);
    const entityNamesPromise = loadEntityNames(storeId, recommendations);
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

    const entityNames = await entityNamesPromise;
    const storedByKey = new Map(stored.map((item) => [item.occurrenceKey, item]));
    return recommendations.map((recommendation) =>
      decorateRecommendation(
        recommendation,
        storedByKey.get(recommendationOccurrenceKey(recommendation)) ?? null,
        recommendation.entityId
          ? entityNames.get(entityKey(recommendation.entityType, recommendation.entityId)) ?? null
          : null,
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
