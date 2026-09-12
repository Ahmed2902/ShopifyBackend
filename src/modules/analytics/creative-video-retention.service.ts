import { prisma } from '../../lib/prisma.js';
import { inRange, type AnalyticsWindows } from './analytics.shared.js';

export type CreativeVideoRetentionStatus =
  | 'READY'
  | 'INSUFFICIENT_PLAYS'
  | 'NO_VIDEO_DATA'
  | 'NOT_VIDEO'
  | 'INCONSISTENT_PROVIDER_DATA';

export type CreativeVideoEvidenceQuality = 'LOW' | 'MEDIUM' | 'HIGH';

export type CreativeVideoRetentionStage =
  | 'START_TO_25'
  | 'P25_TO_50'
  | 'P50_TO_75'
  | 'P75_TO_100';

export interface CreativeVideoRetentionPeriod {
  plays: number | null;
  watched25: number | null;
  watched50: number | null;
  watched75: number | null;
  watched95: number | null;
  watched100: number | null;
  thruplays: number | null;
  watched30Seconds: number | null;
  averageTimeWatchedSeconds: number | null;
  rates: {
    to25: number | null;
    to50: number | null;
    to75: number | null;
    to95: number | null;
    completion: number | null;
  };
  transitions: {
    startTo25: number | null;
    p25To50: number | null;
    p50To75: number | null;
    p75To100: number | null;
  };
  largestDropStage: CreativeVideoRetentionStage | null;
  largestDropRate: number | null;
}

export interface CreativeVideoRetention {
  source: 'META_VIDEO_INSIGHTS';
  status: CreativeVideoRetentionStatus;
  evidenceQuality: CreativeVideoEvidenceQuality;
  minimumDiagnosticPlays: number;
  current: CreativeVideoRetentionPeriod | null;
  comparison: CreativeVideoRetentionPeriod | null;
  change: {
    to25RatePoints: number | null;
    to50RatePoints: number | null;
    to75RatePoints: number | null;
    completionRatePoints: number | null;
    averageTimeWatchedSeconds: number | null;
  };
  limitations: Array<{ code: string; message: string }>;
  interpretation: string;
}

type RetentionRow = {
  date: Date;
  videoMetrics: unknown;
  ad: { creativeId: string | null } | null;
};

type MetricKey =
  | 'plays'
  | 'p25'
  | 'p50'
  | 'p75'
  | 'p95'
  | 'p100'
  | 'thruplay'
  | 'sec30'
  | 'avgTime';

const MIN_DIAGNOSTIC_PLAYS = 100;
const MEDIUM_QUALITY_PLAYS = 500;
const HIGH_QUALITY_PLAYS = 2_000;

function finiteNonNegative(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

/** Meta video metrics are action-like arrays today, but the stored JSON is treated defensively. */
function metricValue(value: unknown): number | null {
  const scalar = finiteNonNegative(value);
  if (scalar !== null) return scalar;

  if (Array.isArray(value)) {
    let total = 0;
    let found = false;
    for (const item of value) {
      const parsed = metricValue(item);
      if (parsed === null) continue;
      total += parsed;
      found = true;
    }
    return found ? total : null;
  }

  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    if ('value' in record) return finiteNonNegative(record.value);
  }

  return null;
}

function metricFromRow(row: RetentionRow, key: MetricKey): number | null {
  if (!row.videoMetrics || typeof row.videoMetrics !== 'object' || Array.isArray(row.videoMetrics)) {
    return null;
  }
  return metricValue((row.videoMetrics as Record<string, unknown>)[key]);
}

function sumMetric(rows: RetentionRow[], key: Exclude<MetricKey, 'avgTime'>): number | null {
  let total = 0;
  let found = false;
  for (const row of rows) {
    const value = metricFromRow(row, key);
    if (value === null) continue;
    total += value;
    found = true;
  }
  return found ? total : null;
}

function weightedAverageWatchTime(rows: RetentionRow[]): number | null {
  let weighted = 0;
  let weight = 0;
  for (const row of rows) {
    const average = metricFromRow(row, 'avgTime');
    const plays = metricFromRow(row, 'plays');
    if (average === null || plays === null || plays <= 0) continue;
    weighted += average * plays;
    weight += plays;
  }
  return weight > 0 ? weighted / weight : null;
}

function rate(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null || denominator <= 0) return null;
  return numerator / denominator;
}

function largestDrop(transitions: CreativeVideoRetentionPeriod['transitions']) {
  const candidates: Array<[CreativeVideoRetentionStage, number | null]> = [
    ['START_TO_25', transitions.startTo25],
    ['P25_TO_50', transitions.p25To50],
    ['P50_TO_75', transitions.p50To75],
    ['P75_TO_100', transitions.p75To100],
  ];
  const available = candidates.filter((entry): entry is [CreativeVideoRetentionStage, number] =>
    entry[1] !== null && Number.isFinite(entry[1]),
  );
  if (available.length === 0) return { stage: null, dropRate: null };
  available.sort((left, right) => left[1] - right[1]);
  return { stage: available[0]![0], dropRate: 1 - available[0]![1] };
}

export function summarizeCreativeVideoRetentionRows(rows: RetentionRow[]): CreativeVideoRetentionPeriod | null {
  if (rows.length === 0) return null;

  const plays = sumMetric(rows, 'plays');
  const watched25 = sumMetric(rows, 'p25');
  const watched50 = sumMetric(rows, 'p50');
  const watched75 = sumMetric(rows, 'p75');
  const watched95 = sumMetric(rows, 'p95');
  const watched100 = sumMetric(rows, 'p100');
  const thruplays = sumMetric(rows, 'thruplay');
  const watched30Seconds = sumMetric(rows, 'sec30');
  const averageTimeWatchedSeconds = weightedAverageWatchTime(rows);

  if (
    plays === null &&
    watched25 === null &&
    watched50 === null &&
    watched75 === null &&
    watched95 === null &&
    watched100 === null &&
    thruplays === null &&
    watched30Seconds === null &&
    averageTimeWatchedSeconds === null
  ) {
    return null;
  }

  const rates = {
    to25: rate(watched25, plays),
    to50: rate(watched50, plays),
    to75: rate(watched75, plays),
    to95: rate(watched95, plays),
    completion: rate(watched100, plays),
  };
  const transitions = {
    startTo25: rates.to25,
    p25To50: rate(watched50, watched25),
    p50To75: rate(watched75, watched50),
    p75To100: rate(watched100, watched75),
  };
  const drop = largestDrop(transitions);

  return {
    plays,
    watched25,
    watched50,
    watched75,
    watched95,
    watched100,
    thruplays,
    watched30Seconds,
    averageTimeWatchedSeconds,
    rates,
    transitions,
    largestDropStage: drop.stage,
    largestDropRate: drop.dropRate,
  };
}

function isInconsistent(period: CreativeVideoRetentionPeriod | null) {
  if (!period) return false;
  const ordered = [
    period.plays,
    period.watched25,
    period.watched50,
    period.watched75,
    period.watched95,
    period.watched100,
  ];
  let previous: number | null = null;
  for (const value of ordered) {
    if (value === null) continue;
    if (previous !== null && value > previous) return true;
    previous = value;
  }
  return false;
}

function evidenceQuality(plays: number | null): CreativeVideoEvidenceQuality {
  if (plays !== null && plays >= HIGH_QUALITY_PLAYS) return 'HIGH';
  if (plays !== null && plays >= MEDIUM_QUALITY_PLAYS) return 'MEDIUM';
  return 'LOW';
}

function points(current: number | null, comparison: number | null) {
  return current === null || comparison === null ? null : current - comparison;
}

function numericChange(current: number | null, comparison: number | null) {
  return current === null || comparison === null ? null : current - comparison;
}

export function buildCreativeVideoRetention(input: {
  isVideo: boolean;
  currentRows: RetentionRow[];
  comparisonRows: RetentionRow[];
}): CreativeVideoRetention {
  if (!input.isVideo) {
    return {
      source: 'META_VIDEO_INSIGHTS',
      status: 'NOT_VIDEO',
      evidenceQuality: 'LOW',
      minimumDiagnosticPlays: MIN_DIAGNOSTIC_PLAYS,
      current: null,
      comparison: null,
      change: {
        to25RatePoints: null,
        to50RatePoints: null,
        to75RatePoints: null,
        completionRatePoints: null,
        averageTimeWatchedSeconds: null,
      },
      limitations: [{ code: 'NOT_VIDEO', message: 'Video retention applies only to video creatives.' }],
      interpretation: 'Not applicable to this creative format.',
    };
  }

  const current = summarizeCreativeVideoRetentionRows(input.currentRows);
  const comparison = summarizeCreativeVideoRetentionRows(input.comparisonRows);
  const inconsistent = isInconsistent(current);
  const currentPlays = current?.plays ?? null;

  let status: CreativeVideoRetentionStatus = 'READY';
  const limitations: Array<{ code: string; message: string }> = [];
  if (!current) {
    status = 'NO_VIDEO_DATA';
    limitations.push({
      code: 'NO_VIDEO_DATA',
      message: 'Meta returned no video retention metrics for this creative in the current window.',
    });
  } else if (inconsistent) {
    status = 'INCONSISTENT_PROVIDER_DATA';
    limitations.push({
      code: 'INCONSISTENT_PROVIDER_DATA',
      message: 'Meta video quartile counts are not monotonic, so Stride does not diagnose a drop-off stage.',
    });
  } else if (currentPlays === null || currentPlays < MIN_DIAGNOSTIC_PLAYS) {
    status = 'INSUFFICIENT_PLAYS';
    limitations.push({
      code: 'INSUFFICIENT_PLAYS',
      message: `At least ${MIN_DIAGNOSTIC_PLAYS} Meta video plays are required for a stage diagnosis.`,
    });
  }

  if (!comparison) {
    limitations.push({
      code: 'NO_COMPARISON_VIDEO_DATA',
      message: 'No comparable Meta video retention evidence is available for the previous window.',
    });
  }

  const safeCurrent = inconsistent && current
    ? { ...current, largestDropStage: null, largestDropRate: null }
    : current;

  return {
    source: 'META_VIDEO_INSIGHTS',
    status,
    evidenceQuality: evidenceQuality(currentPlays),
    minimumDiagnosticPlays: MIN_DIAGNOSTIC_PLAYS,
    current: safeCurrent,
    comparison,
    change: {
      to25RatePoints: points(safeCurrent?.rates.to25 ?? null, comparison?.rates.to25 ?? null),
      to50RatePoints: points(safeCurrent?.rates.to50 ?? null, comparison?.rates.to50 ?? null),
      to75RatePoints: points(safeCurrent?.rates.to75 ?? null, comparison?.rates.to75 ?? null),
      completionRatePoints: points(
        safeCurrent?.rates.completion ?? null,
        comparison?.rates.completion ?? null,
      ),
      averageTimeWatchedSeconds: numericChange(
        safeCurrent?.averageTimeWatchedSeconds ?? null,
        comparison?.averageTimeWatchedSeconds ?? null,
      ),
    },
    limitations,
    interpretation:
      'Observed Meta video retention across selected ads using this creative. Stage drop-off is descriptive evidence, not causal creative-section analysis.',
  };
}

export class CreativeVideoRetentionService {
  async forCreatives(input: {
    storeId: string;
    selectedAccountIds: string[];
    windows: AnalyticsWindows;
    creatives: Array<{ id: string; videoId?: string | null }>;
  }): Promise<Map<string, CreativeVideoRetention>> {
    const output = new Map<string, CreativeVideoRetention>();
    const videoCreativeIds = input.creatives.filter((item) => item.videoId).map((item) => item.id);

    for (const creative of input.creatives) {
      if (!creative.videoId) {
        output.set(creative.id, buildCreativeVideoRetention({
          isVideo: false,
          currentRows: [],
          comparisonRows: [],
        }));
      }
    }

    if (videoCreativeIds.length === 0 || input.selectedAccountIds.length === 0) return output;

    const rows: RetentionRow[] = await prisma.metaInsightDaily.findMany({
      where: {
        level: 'AD',
        date: { gte: input.windows.comparison.metaFrom, lte: input.windows.current.metaTo },
        adAccount: {
          storeId: input.storeId,
          metaAccountId: { in: input.selectedAccountIds },
        },
        ad: { creativeId: { in: videoCreativeIds } },
      },
      select: {
        date: true,
        videoMetrics: true,
        ad: { select: { creativeId: true } },
      },
      orderBy: [{ date: 'asc' }, { adId: 'asc' }],
    });

    for (const creativeId of videoCreativeIds) {
      const creativeRows = rows.filter((row) => row.ad?.creativeId === creativeId);
      output.set(creativeId, buildCreativeVideoRetention({
        isVideo: true,
        currentRows: creativeRows.filter((row) =>
          inRange(row.date, input.windows.current.metaFrom, input.windows.current.metaTo),
        ),
        comparisonRows: creativeRows.filter((row) =>
          inRange(row.date, input.windows.comparison.metaFrom, input.windows.comparison.metaTo),
        ),
      }));
    }

    return output;
  }
}
