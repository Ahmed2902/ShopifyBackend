import { describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/prisma.js', () => ({
  prisma: {
    metaInsightDaily: { findMany: vi.fn() },
    metaCreative: { findMany: vi.fn() },
  },
}));

import { summarizeCreativeVideoRetentionRows } from '../../../src/modules/analytics/creative-video-retention.service.js';

function metric(value: number) {
  return [{ action_type: 'video_view', value: String(value) }];
}

describe('creative retention checkpoint stages', () => {
  it('does not collapse a known 95% checkpoint into a misleading 75%→100% stage', () => {
    const result = summarizeCreativeVideoRetentionRows([
      {
        date: new Date('2026-09-17T00:00:00.000Z'),
        creativeIdSnapshot: 'creative-1',
        videoMetrics: {
          plays: metric(26_445),
          p25: metric(20_660),
          p50: metric(15_469),
          p75: metric(10_443),
          p95: metric(8_171),
          p100: metric(6_958),
        },
      },
    ]);

    expect(result).not.toBeNull();
    expect(result?.rates.to25).toBeCloseTo(0.7812, 3);
    expect(result?.rates.to50).toBeCloseTo(0.5849, 3);
    expect(result?.rates.to75).toBeCloseTo(0.3949, 3);
    expect(result?.rates.to95).toBeCloseTo(0.3090, 3);
    expect(result?.rates.completion).toBeCloseTo(0.2631, 3);
    expect(result?.transitions.p75To95).toBeCloseTo(0.7824, 3);
    expect(result?.transitions.p95To100).toBeCloseTo(0.8515, 3);
    expect(result?.largestDropStage).toBe('P50_TO_75');
    expect(result?.largestDropRate).toBeCloseTo(0.3249, 3);
  });
});
