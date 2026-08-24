import { z } from 'zod';

export const intelligenceQuerySchema = z.object({
  lookbackDays: z.coerce.number().int().min(7).max(90).default(14),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

export type IntelligenceQuery = z.infer<typeof intelligenceQuerySchema>;
