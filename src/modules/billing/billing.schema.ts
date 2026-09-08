import { z } from 'zod';

export const billingPlanSchema = z.object({
  plan: z.enum(['ESSENTIALS', 'PRO']),
});
