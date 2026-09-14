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
  // Generated occurrence keys are compact (<200 chars today). Keep the public mutation bounded
  // below PostgreSQL btree index-entry limits even for multi-byte input rather than allowing an
  // authenticated client to manufacture an oversized unique-index value.
  occurrenceKey: z.string().trim().min(1).max(512),
  state: z.enum(['OPEN', 'REVIEWED', 'DISMISSED', 'RESOLVED']),
});
