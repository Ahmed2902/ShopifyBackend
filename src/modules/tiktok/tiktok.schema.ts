import { z } from 'zod';

export const tiktokCallbackSchema = z.object({
  auth_code: z.string().min(1).optional(),
  code: z.string().min(1).optional(),
  state: z.string().min(1),
}).refine((value) => Boolean(value.auth_code ?? value.code), {
  message: 'TikTok authorization code is required',
  path: ['auth_code'],
});

export const tiktokConfigureAssetsSchema = z.object({
  businessCenterId: z.string().min(1).nullable().optional(),
  advertiserIds: z.array(z.string().min(1)).min(1).max(100).refine(
    (values) => new Set(values).size === values.length,
    'TikTok advertiser IDs must be unique',
  ),
});

export const tiktokConfigureCatalogsSchema = z.object({
  catalogIds: z.array(z.string().min(1)).max(100).refine(
    (values) => new Set(values).size === values.length,
    'TikTok catalog IDs must be unique',
  ),
});

const pagination = {
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
};

export const tiktokCampaignListQuerySchema = z.object({
  ...pagination,
  advertiserId: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
});

export const tiktokAdGroupListQuerySchema = z.object({
  ...pagination,
  campaignId: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
});

export const tiktokAdListQuerySchema = z.object({
  ...pagination,
  campaignId: z.string().min(1).optional(),
  adGroupId: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
});

export const tiktokAdParamsSchema = z.object({ adId: z.string().min(1) });
export const tiktokCatalogParamsSchema = z.object({ catalogId: z.string().min(1) });
export const tiktokCatalogItemsQuerySchema = z.object({ ...pagination });

export const tiktokInsightsSyncSchema = z.object({
  lookbackDays: z.coerce.number().int().min(1).max(365).optional(),
});

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);
export const tiktokInsightsListQuerySchema = z.object({
  ...pagination,
  from: isoDate,
  to: isoDate,
  advertiserId: z.string().min(1).optional(),
  campaignId: z.string().min(1).optional(),
  adGroupId: z.string().min(1).optional(),
  adId: z.string().min(1).optional(),
}).refine((value) => value.from <= value.to, {
  message: 'from must be on or before to',
  path: ['from'],
});

export const tiktokManualAdMappingSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().nullable().optional(),
});

export const tiktokManualCatalogMappingSchema = z.object({
  variantId: z.string().uuid(),
});

export const tiktokWebhookPayloadSchema = z.record(z.string(), z.unknown());
