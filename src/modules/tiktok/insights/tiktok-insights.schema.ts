import { z } from 'zod';

const pagination = {
  page: z.coerce.number().int().positive().default(1),
  limit: z.coerce.number().int().positive().max(100).default(50),
};
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const tiktokInsightsSyncSchema = z.object({
  lookbackDays: z.coerce.number().int().min(1).max(365).optional(),
});

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
