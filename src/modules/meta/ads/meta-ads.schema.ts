import { z } from 'zod';

const optionalMoney = z.union([z.string(), z.number(), z.bigint()]).optional().nullable();
const optionalString = z.string().optional().nullable();
const optionalJson = z.unknown().optional().nullable();

export const metaCampaignSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    status: optionalString,
    configured_status: optionalString,
    effective_status: optionalString,
    objective: optionalString,
    buying_type: optionalString,
    bid_strategy: optionalString,
    daily_budget: optionalMoney,
    lifetime_budget: optionalMoney,
    budget_remaining: optionalMoney,
    spend_cap: optionalMoney,
    start_time: optionalString,
    stop_time: optionalString,
    promoted_object: optionalJson,
    recommendations: optionalJson,
    issues_info: optionalJson,
    created_time: optionalString,
    updated_time: optionalString,
  })
  .passthrough();

export const metaAdSetSchema = z
  .object({
    id: z.string().min(1),
    campaign_id: z.string().min(1),
    name: z.string().min(1),
    status: optionalString,
    configured_status: optionalString,
    effective_status: optionalString,
    daily_budget: optionalMoney,
    lifetime_budget: optionalMoney,
    budget_remaining: optionalMoney,
    daily_spend_cap: optionalMoney,
    lifetime_spend_cap: optionalMoney,
    bid_strategy: optionalString,
    bid_amount: optionalMoney,
    bid_constraints: optionalJson,
    billing_event: optionalString,
    optimization_goal: optionalString,
    destination_type: optionalString,
    is_dynamic_creative: z.boolean().optional().nullable(),
    targeting: optionalJson,
    promoted_object: optionalJson,
    attribution_spec: optionalJson,
    start_time: optionalString,
    end_time: optionalString,
    learning_stage_info: optionalJson,
    recommendations: optionalJson,
    issues_info: optionalJson,
    created_time: optionalString,
    updated_time: optionalString,
  })
  .passthrough();

export const metaCreativeSchema = z
  .object({
    id: z.string().min(1),
    name: optionalString,
    title: optionalString,
    body: optionalString,
    call_to_action: optionalJson,
    call_to_action_type: optionalString,
    image_url: optionalString,
    thumbnail_url: optionalString,
    video_id: optionalString,
    link_url: optionalString,
    link_deep_link_url: optionalString,
    object_url: optionalString,
    object_story_id: optionalString,
    effective_object_story_id: optionalString,
    effective_instagram_media_id: optionalString,
    instagram_permalink_url: optionalString,
    object_story_spec: optionalJson,
    product_set_id: optionalString,
    product_data: optionalJson,
    asset_feed_spec: optionalJson,
    degrees_of_freedom_spec: optionalJson,
    template_url: optionalString,
    template_url_spec: optionalJson,
    url_tags: optionalString,
    created_time: optionalString,
    updated_time: optionalString,
  })
  .passthrough();

export const metaAdSchema = z
  .object({
    id: z.string().min(1),
    campaign_id: z.string().min(1),
    adset_id: z.string().min(1),
    name: z.string().min(1),
    status: optionalString,
    configured_status: optionalString,
    effective_status: optionalString,
    conversion_domain: optionalString,
    source_ad_id: optionalString,
    creative: z.object({ id: z.string().min(1) }).optional().nullable(),
    placement: optionalJson,
    tracking_specs: optionalJson,
    conversion_specs: optionalJson,
    recommendations: optionalJson,
    issues_info: optionalJson,
    adlabels: optionalJson,
    created_time: optionalString,
    updated_time: optionalString,
  })
  .passthrough();

export type MetaCampaignPayload = z.infer<typeof metaCampaignSchema>;
export type MetaAdSetPayload = z.infer<typeof metaAdSetSchema>;
export type MetaCreativePayload = z.infer<typeof metaCreativeSchema>;
export type MetaAdPayload = z.infer<typeof metaAdSchema>;
