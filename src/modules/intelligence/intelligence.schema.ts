import { z } from 'zod';

export const intelligenceReadQuerySchema = z.object({
  fresh: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

export const inventoryModeUpdateSchema = z.object({
  mode: z.enum(['DISABLED', 'TRUSTED', 'UNRELIABLE']),
  restockLeadDays: z.coerce.number().int().min(0).max(365).default(14),
  lowStockThreshold: z.coerce.number().int().min(0).max(1_000_000).default(5),
});

export const recommendationLifecycleUpdateSchema = z.object({
  occurrenceKey: z.string().trim().min(1).max(512),
  state: z.enum(['OPEN', 'REVIEWED', 'DISMISSED', 'RESOLVED']),
});
