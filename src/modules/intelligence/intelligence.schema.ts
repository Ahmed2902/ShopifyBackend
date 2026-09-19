import { z } from 'zod';

export const intelligenceReadQuerySchema = z.object({
  fresh: z
    .enum(['true', 'false'])
    .optional()
    .transform((value) => value === 'true'),
});

export const inventoryModeUpdateSchema = z
  .object({
    mode: z.enum(['DISABLED', 'TRUSTED', 'UNRELIABLE']).optional(),
    restockLeadTimeDays: z.coerce.number().int().min(1).max(365).optional(),
    lowStockThreshold: z.coerce.number().int().min(0).max(1_000_000).optional(),
  })
  .refine(
    (value) =>
      value.mode !== undefined ||
      value.restockLeadTimeDays !== undefined ||
      value.lowStockThreshold !== undefined,
    { message: 'At least one inventory setting must be provided' },
  );

export const recommendationLifecycleUpdateSchema = z.object({
  occurrenceKey: z.string().trim().min(1).max(512),
  state: z.enum(['OPEN', 'REVIEWED', 'DISMISSED', 'RESOLVED']),
});
