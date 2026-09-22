import { z } from 'zod';
import { ADVERTISING_PROVIDERS } from '../integrations/integration.schema.js';

export const billingPlanSchema = z.object({
  plan: z.enum(['ESSENTIALS', 'PRO']),
});

export const billingAdProviderSchema = z.object({
  provider: z.enum(ADVERTISING_PROVIDERS),
});

export const billingReadQuerySchema = z.object({
  fresh: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});
