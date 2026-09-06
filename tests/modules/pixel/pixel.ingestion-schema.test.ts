import { describe, expect, it } from 'vitest';
import { pixelIngestBatchSchema } from '../../../src/modules/pixel/pixel.schema.js';

const installationId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const collectorToken = 'A'.repeat(43);

function event(index: number) {
  return {
    eventId: `event_${String(index).padStart(4, '0')}`,
    eventName: 'PAGE_VIEW' as const,
    eventAt: '2026-09-04T12:00:00.000Z',
    consentState: 'GRANTED' as const,
  };
}

describe('pixel ingestion batch schema', () => {
  it('accepts the maximum bounded batch size', () => {
    const parsed = pixelIngestBatchSchema.parse({
      installationId,
      collectorToken,
      events: Array.from({ length: 50 }, (_, index) => event(index)),
    });

    expect(parsed.events).toHaveLength(50);
  });

  it('rejects oversized batches', () => {
    expect(() =>
      pixelIngestBatchSchema.parse({
        installationId,
        collectorToken,
        events: Array.from({ length: 51 }, (_, index) => event(index)),
      }),
    ).toThrow();
  });

  it('rejects unknown envelope fields instead of accepting PII-shaped additions', () => {
    expect(() =>
      pixelIngestBatchSchema.parse({
        installationId,
        collectorToken,
        email: 'private@example.com',
        events: [event(1)],
      }),
    ).toThrow();
  });
});
