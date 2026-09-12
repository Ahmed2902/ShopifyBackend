import { z } from 'zod';

export const intelligenceReadQuerySchema = z.object({
  fresh: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

export const inventoryModeUpdateSchema = z.object({
  mode: z.enum(['DISABLED', 'TRUSTED', 'UNRELIABLE']),
});

export const recommendationLifecycleUpdateSchema = z.object({
  occurrenceKey: z.string().min(1).max(1000),
  state: z.enum(['OPEN', 'REVIEWED', 'DISMISSED', 'RESOLVED']),
});
