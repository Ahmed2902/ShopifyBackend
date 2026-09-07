import { z } from 'zod';

export const tiktokMonitorQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(90).default(14),
  level: z.enum(['campaigns', 'groups', 'ads']).default('campaigns'),
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  fresh: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

export type TikTokMonitorQuery = z.infer<typeof tiktokMonitorQuerySchema>;
