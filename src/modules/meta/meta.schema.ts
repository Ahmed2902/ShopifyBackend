import { z } from 'zod';

export const metaCallbackSchema = z.object({
  code: z.string().min(1),
  state: z.string().min(1),
});

export const metaConfigureAssetsSchema = z.object({
  metaBusinessId: z.string().min(1).nullable().optional(),
  adAccountIds: z.array(z.string().min(1)).min(1).max(50).refine(
    (values) => new Set(values).size === values.length,
    'Meta ad account IDs must be unique',
  ),
});

const pagination = {
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
};

export const metaCampaignListQuerySchema = z.object({
  ...pagination,
  adAccountId: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
});

export const metaAdSetListQuerySchema = z.object({
  ...pagination,
  campaignId: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
});

export const metaAdListQuerySchema = z.object({
  ...pagination,
  campaignId: z.string().min(1).optional(),
  adSetId: z.string().min(1).optional(),
  status: z.string().min(1).optional(),
});

export const metaAdParamsSchema = z.object({
  adId: z.string().min(1),
});

export const metaTokenResponseSchema = z.object({
  access_token: z.string().min(1),
  token_type: z.string().optional(),
  expires_in: z.coerce.number().int().nonnegative().optional(),
});

export const metaTokenDebugSchema = z.object({
  data: z.object({
    app_id: z.string(),
    type: z.string().optional(),
    application: z.string().optional(),
    data_access_expires_at: z.coerce.number().int().nonnegative().optional(),
    expires_at: z.coerce.number().int().nonnegative().optional(),
    is_valid: z.boolean(),
    scopes: z.array(z.string()).optional().default([]),
    granular_scopes: z.array(z.unknown()).optional(),
    user_id: z.string(),
  }),
});

export const metaUserSchema = z.object({ id: z.string().min(1) });

export const metaBusinessSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
});

export const metaAdAccountSchema = z.object({
  id: z.string().min(1),
  account_id: z.string().min(1),
  name: z.string().min(1),
  account_status: z.coerce.number().int().optional().nullable(),
  currency: z.string().min(1),
  timezone_name: z.string().optional().nullable(),
  timezone_id: z.coerce.number().int().optional().nullable(),
  timezone_offset_hours_utc: z.coerce.number().optional().nullable(),
  amount_spent: z.union([z.string(), z.number(), z.bigint()]).optional().nullable(),
  balance: z.union([z.string(), z.number(), z.bigint()]).optional().nullable(),
  spend_cap: z.union([z.string(), z.number(), z.bigint()]).optional().nullable(),
  business: z
    .object({ id: z.string().min(1), name: z.string().optional() })
    .optional()
    .nullable(),
});

export const metaGraphErrorSchema = z.object({
  error: z.object({
    message: z.string(),
    type: z.string().optional(),
    code: z.coerce.number().int().optional(),
    error_subcode: z.coerce.number().int().optional(),
    is_transient: z.boolean().optional(),
    error_user_title: z.string().optional(),
    error_user_msg: z.string().optional(),
    fbtrace_id: z.string().optional(),
  }),
});
