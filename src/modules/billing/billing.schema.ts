import { z } from 'zod';

export const billingPlanSchema = z.object({
  plan: z.enum(['ESSENTIALS', 'PRO']),
});

export const billingReadQuerySchema = z.object({
  fresh: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});
