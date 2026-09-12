import { describe, expect, it } from 'vitest';
import { recommendationLifecycleUpdateSchema } from '../../../src/modules/intelligence/intelligence.schema.js';
import { recommendationOccurrenceKey } from '../../../src/modules/intelligence/recommendation-lifecycle.service.js';

const baseOccurrence = {
  ruleId: 'creative_fatigue_symptoms',
  ruleVersion: '1',
  entityType: 'CREATIVE' as const,
  entityId: 'creative-1',
  externalEntityId: 'meta-creative-1',
  title: 'Creative fatigue symptoms',
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

describe('recommendationLifecycleUpdateSchema', () => {
  it('accepts a normal backend-issued occurrence key', () => {
    const occurrenceKey = recommendationOccurrenceKey({
      ...baseOccurrence,
      observationStart: '2026-09-01T00:00:00.000Z',
      observationEnd: '2026-09-08T00:00:00.000Z',
    });

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
