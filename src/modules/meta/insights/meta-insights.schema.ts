import { z } from 'zod';

const optionalMetric = z.union([z.string(), z.number()]).optional().nullable();
const actionMetric = z
  .object({
    action_type: z.string().min(1),
    action_destination: z.string().optional().nullable(),
    value: z.union([z.string(), z.number()]),
  })
  .passthrough();

export const metaInsightRowSchema = z
  .object({
    date_start: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    date_stop: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    account_id: z.string().min(1),
    account_currency: z.string().min(1),
    campaign_id: z.string().optional().nullable(),
    adset_id: z.string().optional().nullable(),
    ad_id: z.string().optional().nullable(),
    objective: z.string().optional().nullable(),
    optimization_goal: z.string().optional().nullable(),
    attribution_setting: z.string().optional().nullable(),
    spend: optionalMetric,
    social_spend: optionalMetric,
    impressions: optionalMetric,
    reach: optionalMetric,
    clicks: optionalMetric,
    unique_clicks: optionalMetric,
    inline_link_clicks: optionalMetric,
    inline_post_engagement: optionalMetric,
    estimated_ad_recallers: optionalMetric,
    estimated_ad_recall_rate: optionalMetric,
    cpc: optionalMetric,
    cpm: optionalMetric,
    cpp: optionalMetric,
    ctr: optionalMetric,
    frequency: optionalMetric,
    outbound_clicks: z.array(actionMetric).optional().default([]),
    unique_outbound_clicks: z.array(actionMetric).optional().default([]),
    actions: z.array(actionMetric).optional().default([]),
    unique_actions: z.array(actionMetric).optional().default([]),
    action_values: z.array(actionMetric).optional().default([]),
    cost_per_action_type: z.array(actionMetric).optional().default([]),
    cost_per_unique_action_type: z.array(actionMetric).optional().default([]),
    conversions: z.array(actionMetric).optional().default([]),
    conversion_values: z.array(actionMetric).optional().default([]),
    purchase_roas: z.array(actionMetric).optional().default([]),
    website_purchase_roas: z.array(actionMetric).optional().default([]),
    website_ctr: z.unknown().optional().nullable(),
    video_thruplay_watched_actions: z.unknown().optional().nullable(),
    video_avg_time_watched_actions: z.unknown().optional().nullable(),
    video_p25_watched_actions: z.unknown().optional().nullable(),
    video_p50_watched_actions: z.unknown().optional().nullable(),
    video_p75_watched_actions: z.unknown().optional().nullable(),
    video_p95_watched_actions: z.unknown().optional().nullable(),
    video_p100_watched_actions: z.unknown().optional().nullable(),
    video_30_sec_watched_actions: z.unknown().optional().nullable(),
    video_play_actions: z.unknown().optional().nullable(),
  })
  .passthrough();

export type MetaInsightRow = z.infer<typeof metaInsightRowSchema>;
export type MetaInsightActionRow = z.infer<typeof actionMetric>;
