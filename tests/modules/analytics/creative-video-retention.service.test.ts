import { beforeEach, describe, expect, it, vi } from 'vitest';

const metaInsightDaily = vi.hoisted(() => ({
  findMany: vi.fn(),
}));
const metaCreative = vi.hoisted(() => ({
  findMany: vi.fn(),
}));

vi.mock('../../../src/lib/prisma.js', () => ({
  prisma: { metaInsightDaily, metaCreative },
}));

import {
  buildCreativeVideoRetention,
  CreativeVideoRetentionService,
  summarizeCreativeVideoRetentionRows,
} from '../../../src/modules/analytics/creative-video-retention.service.js';

function action(value: number | string) {
  return [{ action_type: 'video_view', value: String(value) }];
}

function row(input: {
  date?: string;
  creativeId?: string | null;
  plays?: number;
  p25?: number;
  p50?: number;
  p75?: number;
  p95?: number;
  p100?: number;
  thruplay?: number;
  sec30?: number;
  avgTime?: number;
}) {
  const videoMetrics: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(input)) {
    if (key === 'date' || key === 'creativeId' || value === undefined) continue;
    videoMetrics[key] = action(value);
  }
  return {
    date: new Date(`${input.date ?? '2026-09-01'}T00:00:00.000Z`),
    videoMetrics,
    creativeIdSnapshot: input.creativeId === undefined ? 'creative-1' : input.creativeId,
  };
}

const windows = {
  current: {
    fromDate: '2026-09-01',
    toDate: '2026-09-07',
    metaFrom: new Date('2026-09-01T00:00:00.000Z'),
    metaTo: new Date('2026-09-07T00:00:00.000Z'),
    instantFrom: new Date('2026-09-01T00:00:00.000Z'),
    instantTo: new Date('2026-09-07T23:59:59.999Z'),
  },
  comparison: {
    fromDate: '2026-08-25',
    toDate: '2026-08-31',
    metaFrom: new Date('2026-08-25T00:00:00.000Z'),
    metaTo: new Date('2026-08-31T00:00:00.000Z'),
    instantFrom: new Date('2026-08-25T00:00:00.000Z'),
    instantTo: new Date('2026-08-31T23:59:59.999Z'),
  },
  days: 7,
};

describe('creative video retention', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    metaInsightDaily.findMany.mockResolvedValue([]);
    metaCreative.findMany.mockResolvedValue([]);
  });

  it('aggregates counts before deriving rates and weights average watch time by plays', () => {
    const result = summarizeCreativeVideoRetentionRows([
      row({ plays: 100, p25: 80, p50: 60, p75: 30, p95: 25, p100: 20, thruplay: 40, sec30: 10, avgTime: 8 }),
      row({ plays: 300, p25: 240, p50: 180, p75: 90, p95: 75, p100: 60, thruplay: 120, sec30: 30, avgTime: 12 }),
    ]);

    expect(result).not.toBeNull();
    expect(result?.plays).toBe(400);
    expect(result?.watched25).toBe(320);
    expect(result?.rates.to25).toBeCloseTo(0.8);
    expect(result?.rates.completion).toBeCloseTo(0.2);
    expect(result?.transitions.p25To50).toBeCloseTo(0.75);
    expect(result?.transitions.p50To75).toBeCloseTo(0.5);
    expect(result?.largestDropStage).toBe('P50_TO_75');
    expect(result?.largestDropRate).toBeCloseTo(0.5);
    expect(result?.averageTimeWatchedSeconds).toBeCloseTo(11);
  });

  it('marks a video sample below the diagnostic floor as insufficient without inventing a diagnosis', () => {
    const result = buildCreativeVideoRetention({
      isVideo: true,
      currentRows: [row({ plays: 80, p25: 60, p50: 40, p75: 20, p100: 10 })],
      comparisonRows: [],
    });

    expect(result.status).toBe('INSUFFICIENT_PLAYS');
    expect(result.evidenceQuality).toBe('LOW');
    expect(result.current?.plays).toBe(80);
    expect(result.current?.largestDropStage).toBeNull();
    expect(result.current?.largestDropRate).toBeNull();
    expect(result.limitations.map((item) => item.code)).toContain('INSUFFICIENT_PLAYS');
    expect(result.limitations.map((item) => item.code)).toContain('NO_COMPARISON_VIDEO_DATA');
  });

  it('suppresses the drop-off diagnosis when provider quartile counts are inconsistent', () => {
    const result = buildCreativeVideoRetention({
      isVideo: true,
      currentRows: [row({ plays: 1_000, p25: 800, p50: 900, p75: 500, p95: 400, p100: 300 })],
      comparisonRows: [],
    });

    expect(result.status).toBe('INCONSISTENT_PROVIDER_DATA');
    expect(result.current?.largestDropStage).toBeNull();
    expect(result.current?.largestDropRate).toBeNull();
    expect(result.limitations[0]?.code).toBe('INCONSISTENT_PROVIDER_DATA');
  });

  it('suppresses comparison-period diagnoses when the previous sample is too small', () => {
    const result = buildCreativeVideoRetention({
      isVideo: true,
      currentRows: [row({ plays: 1_000, p25: 800, p50: 600, p75: 400, p100: 300 })],
      comparisonRows: [row({ date: '2026-08-30', plays: 50, p25: 40, p50: 20, p75: 10, p100: 5 })],
    });

    expect(result.status).toBe('READY');
    expect(result.comparison?.plays).toBe(50);
    expect(result.comparison?.largestDropStage).toBeNull();
    expect(result.comparison?.largestDropRate).toBeNull();
    expect(result.limitations.map((item) => item.code)).toContain('COMPARISON_INSUFFICIENT_PLAYS');
  });

  it('suppresses comparison-period diagnoses when previous provider quartiles are inconsistent', () => {
    const result = buildCreativeVideoRetention({
      isVideo: true,
      currentRows: [row({ plays: 1_000, p25: 800, p50: 600, p75: 400, p100: 300 })],
      comparisonRows: [row({ date: '2026-08-30', plays: 1_000, p25: 700, p50: 800, p75: 400, p100: 200 })],
    });

    expect(result.status).toBe('READY');
    expect(result.comparison?.largestDropStage).toBeNull();
    expect(result.limitations.map((item) => item.code)).toContain('COMPARISON_INCONSISTENT_PROVIDER_DATA');
  });

  it('keeps non-video creatives explicit instead of returning zero retention', () => {
    const result = buildCreativeVideoRetention({
      isVideo: false,
      currentRows: [],
      comparisonRows: [],
    });

    expect(result.status).toBe('NOT_VIDEO');
    expect(result.current).toBeNull();
    expect(result.limitations[0]?.code).toBe('NOT_VIDEO');
  });

  it('distinguishes missing Meta video evidence from a zero-performing video', () => {
    const result = buildCreativeVideoRetention({
      isVideo: true,
      currentRows: [{
        date: new Date('2026-09-01T00:00:00.000Z'),
        videoMetrics: { plays: null, p25: null },
        creativeIdSnapshot: 'creative-1',
      }],
      comparisonRows: [],
    });

    expect(result.status).toBe('NO_VIDEO_DATA');
    expect(result.current).toBeNull();
  });

  it('returns current-vs-previous retention changes as percentage-point deltas', () => {
    const result = buildCreativeVideoRetention({
      isVideo: true,
      currentRows: [row({ plays: 1_000, p25: 800, p50: 600, p75: 400, p100: 300, avgTime: 12 })],
      comparisonRows: [row({ date: '2026-08-30', plays: 1_000, p25: 700, p50: 500, p75: 300, p100: 200, avgTime: 10 })],
    });

    expect(result.status).toBe('READY');
    expect(result.evidenceQuality).toBe('MEDIUM');
    expect(result.change.to25RatePoints).toBeCloseTo(0.1);
    expect(result.change.completionRatePoints).toBeCloseTo(0.1);
    expect(result.change.averageTimeWatchedSeconds).toBeCloseTo(2);
  });

  it('binds retention rows to the immutable creative snapshot instead of the ad current creative', async () => {
    metaInsightDaily.findMany.mockResolvedValue([
      row({ creativeId: 'creative-old', plays: 1_000, p25: 800, p50: 600, p75: 400, p100: 300 }),
    ]);

    const result = await new CreativeVideoRetentionService().forCreatives({
      storeId: 'store-1',
      selectedAccountIds: ['act-1'],
      windows,
      creatives: [
        { id: 'creative-old', videoId: 'video-old' },
        { id: 'creative-new', videoId: 'video-new' },
      ],
    });

    expect(result.get('creative-old')?.current?.plays).toBe(1_000);
    expect(result.get('creative-new')?.current).toBeNull();
    expect(metaInsightDaily.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        creativeIdSnapshot: { in: ['creative-old', 'creative-new'] },
      }),
      select: expect.objectContaining({ creativeIdSnapshot: true }),
    }));
  });

  it('ignores ambiguous historical rows with no creative snapshot instead of guessing', async () => {
    metaInsightDaily.findMany.mockResolvedValue([
      row({ creativeId: null, plays: 5_000, p25: 4_000, p50: 3_000, p75: 2_000, p100: 1_000 }),
    ]);

    const result = await new CreativeVideoRetentionService().forCreatives({
      storeId: 'store-1',
      selectedAccountIds: ['act-1'],
      windows,
      creatives: [{ id: 'creative-1', videoId: 'video-1' }],
    });

    expect(result.get('creative-1')?.status).toBe('NO_VIDEO_DATA');
    expect(result.get('creative-1')?.current).toBeNull();
  });

  it('infers dynamic-video applicability from stored Meta video evidence when no top-level videoId exists', async () => {
    metaInsightDaily.findMany.mockResolvedValue([
      row({ creativeId: 'dynamic-creative', plays: 1_000, p25: 800, p50: 600, p75: 400, p100: 300 }),
    ]);

    const result = await new CreativeVideoRetentionService().forCreatives({
      storeId: 'store-1',
      selectedAccountIds: ['act-1'],
      windows,
      creatives: [{ id: 'dynamic-creative', videoId: null }],
    });

    expect(result.get('dynamic-creative')?.status).toBe('READY');
    expect(result.get('dynamic-creative')?.current?.plays).toBe(1_000);
  });

  it('recognizes asset-feed video creatives even when the requested window has no delivery', async () => {
    metaCreative.findMany.mockResolvedValue([
      { id: 'dynamic-creative', assetFeedSpec: { videos: [{ video_id: 'video-1' }] } },
    ]);

    const result = await new CreativeVideoRetentionService().forCreatives({
      storeId: 'store-1',
      selectedAccountIds: ['act-1'],
      windows,
      creatives: [{ id: 'dynamic-creative', videoId: null }],
    });

    expect(result.get('dynamic-creative')?.status).toBe('NO_VIDEO_DATA');
    expect(result.get('dynamic-creative')?.limitations.map((item) => item.code)).toContain(
      'NO_VIDEO_DATA',
    );
  });
});
