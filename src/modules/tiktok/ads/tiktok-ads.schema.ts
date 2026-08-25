import { z } from 'zod';

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
