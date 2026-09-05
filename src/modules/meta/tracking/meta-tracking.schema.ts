import { z } from 'zod';

const metaNumericIdSchema = z.string().trim().regex(/^\d+$/).max(128);

export const metaTrackingApplySchema = z
  .object({
    adIds: z.array(metaNumericIdSchema).min(1).max(50).optional(),
    dryRun: z.boolean().default(false),
  })
  .strict();

export type MetaTrackingApplyInput = z.infer<typeof metaTrackingApplySchema>;
