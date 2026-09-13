import { env } from '../../../config/env.js';
import { AppError } from '../../../errors/app-error.js';
import type { MetaApiContext } from '../meta.types.js';
import { parseMetaRecord, toJsonSafe } from '../meta.utils.js';
import type { MetaApiService } from '../shared/meta-api.service.js';
import type { MetaInsightsRepository } from './meta-insights.repository.js';
import { metaInsightRowSchema } from './meta-insights.schema.js';

const CHUNK_DAYS = 28;
const ACTION_REPORT_TIME = 'impression';
const INSIGHT_FIELDS = [
  'date_start', 'date_stop', 'account_id', 'account_currency', 'campaign_id', 'adset_id', 'ad_id',
  'objective', 'optimization_goal', 'attribution_setting', 'spend', 'social_spend', 'impressions',
  'reach', 'clicks', 'unique_clicks', 'outbound_clicks', 'unique_outbound_clicks',
  'inline_link_clicks', 'inline_post_engagement', 'estimated_ad_recallers',
  'estimated_ad_recall_rate', 'cpc', 'cpm', 'cpp', 'ctr', 'frequency', 'actions', 'unique_actions',
  'action_values', 'cost_per_action_type', 'cost_per_unique_action_type', 'conversions',
  'conversion_values', 'purchase_roas', 'website_purchase_roas', 'website_ctr',
  'video_thruplay_watched_actions', 'video_avg_time_watched_actions', 'video_p25_watched_actions',
  'video_p50_watched_actions', 'video_p75_watched_actions', 'video_p95_watched_actions',
  'video_p100_watched_actions', 'video_30_sec_watched_actions', 'video_play_actions',
].join(',');

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function startOfUtcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date: Date, days: number): Date {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

export class MetaInsightsService {
  constructor(
    private readonly repository: MetaInsightsRepository,
    private readonly apiService: MetaApiService,
  ) {}

  async syncAccount(context: MetaApiContext, metaAccountId: string, requestedLookbackDays?: number) {
    const account = await this.repository.findAccount(
      context.storeId,
      context.connectionId,
      metaAccountId,
    );
    if (!account) {
      throw new AppError(
        'Selected Meta ad account is missing from local configuration',
        409,
        'META_AD_ACCOUNT_NOT_CONFIGURED',
      );
    }

    const hasExistingInsights = await this.repository.hasInsights(account.id);
    const lookbackDays =
      requestedLookbackDays ??
      (hasExistingInsights ? env.META_REFRESH_LOOKBACK_DAYS : env.META_INITIAL_LOOKBACK_DAYS);
    if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 365) {
      throw new AppError('Meta Insights lookback must be between 1 and 365 days', 400, 'INVALID_LOOKBACK');
    }

    const today = startOfUtcDay(new Date());
    const todayDate = dateOnly(today);
    const firstDay = addDays(today, -(lookbackDays - 1));
    const hierarchy = await this.repository.getHierarchyMaps(account.id);
    let recordsRead = 0;
    let recordsWritten = 0;
    let staleRowsDeleted = 0;

    for (let chunkStart = firstDay; chunkStart <= today; chunkStart = addDays(chunkStart, CHUNK_DAYS)) {
      const chunkEnd = new Date(
        Math.min(addDays(chunkStart, CHUNK_DAYS - 1).getTime(), today.getTime()),
      );
      const rows = await this.apiService.collectGraphPages(
        context,
        `/${metaAccountId}/insights`,
        {
          level: 'ad',
          time_increment: '1',
          time_range: JSON.stringify({ since: dateOnly(chunkStart), until: dateOnly(chunkEnd) }),
          use_unified_attribution_setting: 'true',
          action_report_time: ACTION_REPORT_TIME,
          action_breakdowns: 'action_type,action_destination',
          fields: INSIGHT_FIELDS,
          limit: '100',
        },
        (value) => parseMetaRecord(metaInsightRowSchema, value, 'Meta Insights returned an invalid row'),
      );

      const keys: string[] = [];
      const expectedAccountId = metaAccountId.replace(/^act_/, '');
      for (const row of rows) {
        if (row.account_id !== expectedAccountId && row.account_id !== metaAccountId) {
          throw new AppError(
            'Meta Insights returned data for a different ad account',
            502,
            'META_IDENTITY_MISMATCH',
          );
        }

        // Meta Insights is daily and does not expose historical creative identity. Snapshot the
        // currently observed creative only for today's fresh row. Older backfill rows remain null
        // rather than being guessed from the ad's current creative association.
        const creativeIdSnapshot =
          row.date_start === todayDate && row.ad_id
            ? hierarchy.adCreatives.get(row.ad_id) ?? null
            : null;

        keys.push(
          await this.repository.upsertDailyInsight({
            adAccountId: account.id,
            campaignId: row.campaign_id ? hierarchy.campaigns.get(row.campaign_id) ?? null : null,
            adSetId: row.adset_id ? hierarchy.adSets.get(row.adset_id) ?? null : null,
            adId: row.ad_id ? hierarchy.ads.get(row.ad_id) ?? null : null,
            creativeIdSnapshot,
            row,
            actionReportTime: ACTION_REPORT_TIME,
          }),
        );
      }

      const deleted = await this.repository.deleteMissingRange(account.id, chunkStart, chunkEnd, keys);
      recordsRead += rows.length;
      recordsWritten += rows.length + deleted.count;
      staleRowsDeleted += deleted.count;
    }

    return {
      recordsRead,
      recordsWritten,
      lookbackDays,
      initialBackfill: !hasExistingInsights,
      staleRowsDeleted,
      actionReportTime: ACTION_REPORT_TIME,
      attributionMode: 'UNIFIED_ADSET_SETTING' as const,
    };
  }

  async listDaily(
    storeId: string,
    input: { from: string; to: string; adId?: string; page: number; limit: number },
  ) {
    return toJsonSafe(
      await this.repository.listDaily(storeId, {
        from: new Date(`${input.from}T00:00:00.000Z`),
        to: new Date(`${input.to}T23:59:59.999Z`),
        adId: input.adId,
        page: input.page,
        limit: input.limit,
      }),
    );
  }
}
