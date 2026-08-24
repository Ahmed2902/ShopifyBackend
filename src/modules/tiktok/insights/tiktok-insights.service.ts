import { createHash } from 'node:crypto';
import type { TikTokApiService } from '../shared/tiktok-api.service.js';
import type { TikTokApiContext } from '../tiktok.types.js';
import { asNumber, asRecord, asString } from '../tiktok.utils.js';
import type { TikTokAdsRepository } from '../ads/tiktok-ads.repository.js';
import type { TikTokInsightsRepository } from './tiktok-insights.repository.js';

export const DEFAULT_TIKTOK_INSIGHTS_LOOKBACK_DAYS = 35;
const REPORT_CHUNK_DAYS = 28;

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

        for (const row of rows) {
          const dimensions = asRecord(row.dimensions);
          const metrics = asRecord(row.metrics);
          const externalAdId = asString(dimensions.ad_id) ?? asString(row.ad_id);
          const dateText = asString(dimensions.stat_time_day) ?? asString(row.stat_time_day);
          if (!externalAdId || !dateText) continue;

          const localAd = await this.adsRepository.getAd(storeId, externalAdId);
          if (!localAd || localAd.advertiser.advertiserId !== advertiserId) continue;
          const date = new Date(`${dateText.slice(0, 10)}T00:00:00.000Z`);
          if (Number.isNaN(date.getTime())) continue;
          const insightKey = createHash('sha256')
            .update(['TIKTOK', advertiserId, externalAdId, formatDate(date)].join(':'))
            .digest('hex');

          await this.repository.upsertInsight({
            insightKey,
            advertiserDbId: localAd.advertiserDbId,
            campaignId: localAd.campaignId,
            adGroupId: localAd.adGroupId,
            adId: localAd.id,
            level: 'AD',
            date,
            accountCurrency: localAd.advertiser.currency,
            spend: asNumber(metrics.spend) ?? 0,
            impressions: BigInt(asString(metrics.impressions) ?? '0'),
            reach: metrics.reach == null ? null : BigInt(asString(metrics.reach) ?? '0'),
            clicks: BigInt(asString(metrics.clicks) ?? '0'),
            ctr: asNumber(metrics.ctr),
            cpc: asNumber(metrics.cpc),
            cpm: asNumber(metrics.cpm),
            frequency: asNumber(metrics.frequency),
            conversions: asNumber(metrics.complete_payment),
            conversionValue: asNumber(metrics.total_complete_payment_rate),
            costPerConversion: asNumber(metrics.cost_per_complete_payment),
            roas: asNumber(metrics.complete_payment_roas),
            videoPlayActions: metrics.video_play_actions == null ? null : BigInt(asString(metrics.video_play_actions) ?? '0'),
            videoWatched2s: metrics.video_watched_2s == null ? null : BigInt(asString(metrics.video_watched_2s) ?? '0'),
            videoWatched6s: metrics.video_watched_6s == null ? null : BigInt(asString(metrics.video_watched_6s) ?? '0'),
            videoViewsP25: metrics.video_views_p25 == null ? null : BigInt(asString(metrics.video_views_p25) ?? '0'),
            videoViewsP50: metrics.video_views_p50 == null ? null : BigInt(asString(metrics.video_views_p50) ?? '0'),
            videoViewsP75: metrics.video_views_p75 == null ? null : BigInt(asString(metrics.video_views_p75) ?? '0'),
            videoViewsP100: metrics.video_views_p100 == null ? null : BigInt(asString(metrics.video_views_p100) ?? '0'),
            dimensionsJson: dimensions,
            metricsJson: metrics,
            rawJson: row,
            syncedAt: new Date(),
          });
          recordsWritten += 1;
        }
      }
    }

    return { recordsRead, recordsWritten };
  }
}
