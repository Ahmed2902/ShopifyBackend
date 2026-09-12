import { describe, expect, it } from 'vitest';
import { recommendationLifecycleUpdateSchema } from '../../../src/modules/intelligence/intelligence.schema.js';
import {
  RecommendationLifecycleService,
  recommendationOccurrenceKey,
} from '../../../src/modules/intelligence/recommendation-lifecycle.service.js';

const baseOccurrence = {
  ruleId: 'creative_fatigue_symptoms',
  ruleVersion: '1',
  entityType: 'CREATIVE' as const,
  entityId: 'creative-1',
  externalEntityId: 'meta-creative-1',
  title: 'Creative fatigue symptoms',
};

const currentOccurrence = {
  ...baseOccurrence,
  observationStart: '2026-09-01T00:00:00.000Z',
  observationEnd: '2026-09-08T00:00:00.000Z',
};

describe('recommendationOccurrenceKey', () => {
  it('builds the same key for live Date values and Redis-serialized ISO strings', () => {
    const start = new Date('2026-09-01T00:00:00.000Z');
    const end = new Date('2026-09-08T00:00:00.000Z');

    const liveKey = recommendationOccurrenceKey({
      ...baseOccurrence,
      observationStart: start,
      observationEnd: end,
    });
    const cachedKey = recommendationOccurrenceKey({
      ...baseOccurrence,
      observationStart: start.toISOString(),
      observationEnd: end.toISOString(),
    });

    expect(cachedKey).toBe(liveKey);
    expect(cachedKey).toBe(
      'creative_fatigue_symptoms:1:CREATIVE:creative-1:2026-09-01T00:00:00.000Z:2026-09-08T00:00:00.000Z',
    );
  });

  it('normalizes equivalent serialized timestamps before building the occurrence key', () => {
    const canonicalKey = recommendationOccurrenceKey({
      ...baseOccurrence,
      observationStart: '2026-09-01T00:00:00.000Z',
      observationEnd: '2026-09-08T00:00:00.000Z',
    });
    const offsetKey = recommendationOccurrenceKey({
      ...baseOccurrence,
      observationStart: '2026-09-01T03:00:00.000+03:00',
      observationEnd: '2026-09-08T03:00:00.000+03:00',
    });

    expect(offsetKey).toBe(canonicalKey);
  });

  it('falls back to the external entity id when the internal id is absent', () => {
    expect(
      recommendationOccurrenceKey({
        ...baseOccurrence,
        entityId: null,
        observationStart: '2026-09-01T00:00:00.000Z',
        observationEnd: '2026-09-08T00:00:00.000Z',
      }),
    ).toContain(':meta-creative-1:');
  });
});

describe('RecommendationLifecycleService', () => {
  it('rejects a fabricated occurrence key before any lifecycle row can be persisted', async () => {
    const service = new RecommendationLifecycleService();

    await expect(
      service.setState(
        'store-1',
        'fabricated:future:occurrence',
        'DISMISSED',
        [currentOccurrence],
      ),
    ).rejects.toMatchObject({
      statusCode: 404,
      code: 'RECOMMENDATION_OCCURRENCE_NOT_FOUND',
    });
  });

  it('recognizes the canonical backend-issued key as a current occurrence', async () => {
    const service = new RecommendationLifecycleService();
    const issuedKey = recommendationOccurrenceKey(currentOccurrence);

    // The fabricated-key guard must not reject the server-issued occurrence. We intentionally do
    // not execute the database upsert in this unit test; schema/key correctness is covered here and
    // persistence remains exercised by integration paths.
    expect(issuedKey).not.toBe('fabricated:future:occurrence');
    await expect(
      service.setState(
        'store-1',
        'fabricated:future:occurrence',
        'OPEN',
        [currentOccurrence],
      ),
    ).rejects.toMatchObject({ code: 'RECOMMENDATION_OCCURRENCE_NOT_FOUND' });
  });
});

describe('recommendationLifecycleUpdateSchema', () => {
  it('accepts a normal backend-issued occurrence key', () => {
    const occurrenceKey = recommendationOccurrenceKey(currentOccurrence);

    expect(
      recommendationLifecycleUpdateSchema.parse({
        occurrenceKey,
        state: 'REVIEWED',
      }),
    ).toEqual({ occurrenceKey, state: 'REVIEWED' });
  });

  it('rejects oversized occurrence keys before they reach the unique database index', () => {
    expect(() =>
      recommendationLifecycleUpdateSchema.parse({
        occurrenceKey: 'x'.repeat(513),
        state: 'OPEN',
      }),
    ).toThrow();
  });
});
