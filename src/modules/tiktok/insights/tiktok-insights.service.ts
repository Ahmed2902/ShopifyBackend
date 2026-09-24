import { createHash } from 'node:crypto';
import type { Prisma } from '../../../generated/prisma/client.js';
import { prisma } from '../../../lib/prisma.js';
import type { TikTokApiService } from '../shared/tiktok-api.service.js';
import type { TikTokApiContext } from '../tiktok.types.js';
import { asNumber, asRecord, asString } from '../tiktok.utils.js';
import type { TikTokAdsRepository } from '../ads/tiktok-ads.repository.js';
import type { TikTokInsightsRepository } from './tiktok-insights.repository.js';

export const DEFAULT_TIKTOK_INSIGHTS_LOOKBACK_DAYS = 35;
const REPORT_CHUNK_DAYS = 28;
const INSIGHT_WRITE_BATCH_SIZE = 100;

function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function dateChunks(lookbackDays: number): Array<{ start: string; end: string }> {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - Math.max(0, lookbackDays - 1));
  const chunks: Array<{ start: string; end: string }> = [];
  let cursor = start;
  while (cursor <= end) {
    const chunkEnd = new Date(cursor);
    chunkEnd.setUTCDate(chunkEnd.getUTCDate() + REPORT_CHUNK_DAYS - 1);
    if (chunkEnd > end) chunkEnd.setTime(end.getTime());
    chunks.push({ start: formatDate(cursor), end: formatDate(chunkEnd) });
    cursor = new Date(chunkEnd);
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return chunks;
}

function batches<T>(items: T[], size: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < items.length; index += size) result.push(items.slice(index, index + size));
  return result;
}

function bigintMetric(value: unknown): bigint | null {
  if (value === null || value === undefined) return null;
  const text = asString(value);
  return text === null ? null : BigInt(text);
}

export class TikTokInsightsService {
  constructor(
    private readonly repository: TikTokInsightsRepository,
    private readonly adsRepository: TikTokAdsRepository,
    private readonly apiService: TikTokApiService,
  ) {}

  listInsights(storeId: string, input: {
    page: number;
    limit: number;
    from: string;
    to: string;
    advertiserId?: string;
    campaignId?: string;
    adGroupId?: string;
    adId?: string;
  }) {
    const from = new Date(`${input.from}T00:00:00.000Z`);
    const to = new Date(`${input.to}T00:00:00.000Z`);
    return this.repository.listInsights(storeId, { ...input, from, to })
      .then(([items, total]) => ({ items, page: input.page, limit: input.limit, total }));
  }

  async syncSelectedAdvertisers(
    storeId: string,
    context: TikTokApiContext,
    lookbackDays = DEFAULT_TIKTOK_INSIGHTS_LOOKBACK_DAYS,
  ) {
    let recordsRead = 0;
    let recordsWritten = 0;

    for (const advertiserId of context.selectedAdvertiserIds) {
      const [advertiser] = await this.adsRepository.findSelectedAdvertisers(storeId, [advertiserId]);
      if (!advertiser || advertiser.advertiserId !== advertiserId) continue;

      for (const chunk of dateChunks(lookbackDays)) {
        const rows = await this.apiService.paginate(context, 'report/integrated/get', {
          advertiser_id: advertiserId,
          report_type: 'BASIC',
          data_level: 'AUCTION_AD',
          dimensions: ['ad_id', 'stat_time_day'],
          metrics: [
            'spend', 'impressions', 'reach', 'clicks', 'ctr', 'cpc', 'cpm', 'frequency',
            'complete_payment', 'cost_per_complete_payment', 'complete_payment_roas', 'total_complete_payment_rate',
            'video_play_actions', 'video_watched_2s', 'video_watched_6s', 'video_views_p25', 'video_views_p50', 'video_views_p75', 'video_views_p100',
          ],
          start_date: chunk.start,
          end_date: chunk.end,
        }, ['list']);
        recordsRead += rows.length;

        const externalAdIds = [...new Set(rows
          .map((row) => {
            const dimensions = asRecord(row.dimensions);
            return asString(dimensions.ad_id) ?? asString(row.ad_id);
          })
          .filter((value): value is string => Boolean(value)))];

        const localAds = externalAdIds.length === 0
          ? []
          : await prisma.tikTokAd.findMany({
              where: {
                advertiserDbId: advertiser.id,
                tiktokAdId: { in: externalAdIds },
                deletedAt: null,
              },
              select: {
                id: true,
                tiktokAdId: true,
                advertiserDbId: true,
                campaignId: true,
                adGroupId: true,
              },
            });
        const adsByExternalId = new Map(localAds.map((ad) => [ad.tiktokAdId, ad] as const));
        const pending: Prisma.TikTokInsightDailyUncheckedCreateInput[] = [];

        for (const row of rows) {
          const dimensions = asRecord(row.dimensions);
          const metrics = asRecord(row.metrics);
          const externalAdId = asString(dimensions.ad_id) ?? asString(row.ad_id);
          const dateText = asString(dimensions.stat_time_day) ?? asString(row.stat_time_day);
          if (!externalAdId || !dateText) continue;

          const localAd = adsByExternalId.get(externalAdId);
          if (!localAd) continue;
          const date = new Date(`${dateText.slice(0, 10)}T00:00:00.000Z`);
          if (Number.isNaN(date.getTime())) continue;
          const insightKey = createHash('sha256')
            .update(['TIKTOK', advertiserId, externalAdId, formatDate(date)].join(':'))
            .digest('hex');

          pending.push({
            insightKey,
            advertiserDbId: localAd.advertiserDbId,
            campaignId: localAd.campaignId,
            adGroupId: localAd.adGroupId,
            adId: localAd.id,
            level: 'AD',
            date,
            accountCurrency: advertiser.currency,
            spend: asNumber(metrics.spend) ?? 0,
            impressions: bigintMetric(metrics.impressions) ?? 0n,
            reach: bigintMetric(metrics.reach),
            clicks: bigintMetric(metrics.clicks) ?? 0n,
            ctr: asNumber(metrics.ctr),
            cpc: asNumber(metrics.cpc),
            cpm: asNumber(metrics.cpm),
            frequency: asNumber(metrics.frequency),
            conversions: asNumber(metrics.complete_payment),
            // total_complete_payment_rate is a rate, not money. Keep it in metricsJson/provider
            // evidence below; canonical conversionValue stays unavailable until TikTok supplies a
            // trustworthy monetary conversion-value field for this reporting contract.
            conversionValue: null,
            costPerConversion: asNumber(metrics.cost_per_complete_payment),
            roas: asNumber(metrics.complete_payment_roas),
            videoPlayActions: bigintMetric(metrics.video_play_actions),
            videoWatched2s: bigintMetric(metrics.video_watched_2s),
            videoWatched6s: bigintMetric(metrics.video_watched_6s),
            videoViewsP25: bigintMetric(metrics.video_views_p25),
            videoViewsP50: bigintMetric(metrics.video_views_p50),
            videoViewsP75: bigintMetric(metrics.video_views_p75),
            videoViewsP100: bigintMetric(metrics.video_views_p100),
            dimensionsJson: dimensions as Prisma.InputJsonValue,
            metricsJson: metrics as Prisma.InputJsonValue,
            rawJson: row as Prisma.InputJsonValue,
            syncedAt: new Date(),
          });
        }

        for (const batch of batches(pending, INSIGHT_WRITE_BATCH_SIZE)) {
          const written = await this.repository.upsertInsights(batch);
          recordsWritten += written.length;
        }
      }
    }

    return { recordsRead, recordsWritten };
  }
}
