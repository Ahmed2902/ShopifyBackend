import { z } from 'zod';

export const pixelMappingEvidenceQuerySchema = z
  .object({
    targetType: z.enum(['PRODUCT', 'COLLECTION']),
  })
  .strict();

export type PixelMappingEvidenceQuery = z.infer<typeof pixelMappingEvidenceQuerySchema>;
