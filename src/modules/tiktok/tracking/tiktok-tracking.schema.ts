import { z } from 'zod';
export const tiktokTrackingApplySchema = z
  .object({
    adIds: z.array(z.string().regex(/^\d+$/).max(128)).min(1).max(50),
    dryRun: z.boolean().default(true),
    previewToken: z.string().min(1).max(20000).optional(),
  })
  .strict()
  .refine((v) => v.dryRun || Boolean(v.previewToken), {
    message: 'Preview tracking changes before applying them.',
  });
export type TikTokTrackingApplyInput = z.infer<typeof tiktokTrackingApplySchema>;
