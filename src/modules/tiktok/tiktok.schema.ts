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
