import { prisma } from '../../lib/prisma.js';
import { inRange, type AnalyticsWindows } from './analytics.shared.js';
import {
  buildCreativeVideoRetention,
  CreativeVideoRetentionService,
  type CreativeVideoRetention,
} from './creative-video-retention.service.js';

type RetentionRow = {
  date: Date;
  videoMetrics: unknown;
  creativeIdSnapshot: string | null;
};

const VIDEO_METRIC_KEYS = [
  'plays',
  'p25',
  'p50',
  'p75',
  'p95',
  'p100',
  'thruplay',
  'sec30',
  'avgTime',
] as const;

function finiteNonNegative(value: unknown): number | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  if (typeof value === 'string' && value.trim() === '') return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

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

function rowHasVideoEvidence(row: RetentionRow) {
  if (!row.videoMetrics || typeof row.videoMetrics !== 'object' || Array.isArray(row.videoMetrics)) {
    return false;
  }
  const metrics = row.videoMetrics as Record<string, unknown>;
  return VIDEO_METRIC_KEYS.some((key) => metricValue(metrics[key]) !== null);
}

function assetFeedHasVideo(assetFeedSpec: unknown) {
  if (!assetFeedSpec || typeof assetFeedSpec !== 'object' || Array.isArray(assetFeedSpec)) return false;
  const videos = (assetFeedSpec as Record<string, unknown>).videos;
  if (Array.isArray(videos)) return videos.length > 0;
  return Boolean(
    videos &&
      typeof videos === 'object' &&
      !Array.isArray(videos) &&
      Object.keys(videos as Record<string, unknown>).length > 0,
  );
}

function nestedObject(value: unknown, key: string): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return (value as Record<string, unknown>)[key] ?? null;
}

/**
 * Meta video-retention semantics remain provider-specific, but their persistence source is now the
 * canonical advertising model. This isolates provider interpretation without making analytics or
 * intelligence depend on MetaInsightDaily / MetaCreative tables.
 */
export class CanonicalCreativeVideoRetentionService extends CreativeVideoRetentionService {
  override async forCreatives(input: {
    storeId: string;
    selectedAccountIds: string[];
    windows: AnalyticsWindows;
    creatives: Array<{ id: string; videoId?: string | null }>;
  }): Promise<Map<string, CreativeVideoRetention>> {
    const output = new Map<string, CreativeVideoRetention>();
    const creativeIds = input.creatives.map((item) => item.id);
    if (creativeIds.length === 0) return output;

    const [metadata, metricRows] = await Promise.all([
      prisma.advertisingCreative.findMany({
        where: {
          id: { in: creativeIds },
          deletedAt: null,
          account: {
            storeId: input.storeId,
            provider: 'META',
            ...(input.selectedAccountIds.length > 0
              ? { providerEntityId: { in: input.selectedAccountIds } }
              : {}),
          },
        },
        select: { id: true, videoId: true, providerData: true },
      }),
      input.selectedAccountIds.length > 0
        ? prisma.advertisingDailyMetric.findMany({
            where: {
              level: 'AD',
              date: { gte: input.windows.comparison.metaFrom, lte: input.windows.current.metaTo },
              account: {
                storeId: input.storeId,
                provider: 'META',
                providerEntityId: { in: input.selectedAccountIds },
              },
              creativeIdSnapshot: { in: creativeIds },
            },
            select: {
              date: true,
              creativeIdSnapshot: true,
              providerMetrics: true,
            },
            orderBy: [{ date: 'asc' }, { creativeIdSnapshot: 'asc' }],
          })
        : Promise.resolve([]),
    ]);

    const metadataByCreative = new Map(
      metadata.map((creative) => [creative.id, creative] as const),
    );
    const rowsByCreative = new Map<string, RetentionRow[]>();
    for (const metric of metricRows) {
      if (!metric.creativeIdSnapshot) continue;
      const row: RetentionRow = {
        date: metric.date,
        creativeIdSnapshot: metric.creativeIdSnapshot,
        videoMetrics: nestedObject(metric.providerMetrics, 'videoMetrics'),
      };
      const group = rowsByCreative.get(metric.creativeIdSnapshot) ?? [];
      group.push(row);
      rowsByCreative.set(metric.creativeIdSnapshot, group);
    }

    for (const creative of input.creatives) {
      const persisted = metadataByCreative.get(creative.id);
      const rows = rowsByCreative.get(creative.id) ?? [];
      const assetFeedSpec = nestedObject(persisted?.providerData, 'assetFeedSpec');
      const isVideo =
        Boolean(creative.videoId) ||
        Boolean(persisted?.videoId) ||
        assetFeedHasVideo(assetFeedSpec) ||
        rows.some(rowHasVideoEvidence);

      output.set(
        creative.id,
        buildCreativeVideoRetention({
          isVideo,
          currentRows: rows.filter((row) =>
            inRange(row.date, input.windows.current.metaFrom, input.windows.current.metaTo),
          ),
          comparisonRows: rows.filter((row) =>
            inRange(row.date, input.windows.comparison.metaFrom, input.windows.comparison.metaTo),
          ),
        }),
      );
    }

    return output;
  }
}
