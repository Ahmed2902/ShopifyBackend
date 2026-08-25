import { z } from 'zod';

export const tiktokMappingAdParamsSchema = z.object({ adId: z.string().min(1) });

export const tiktokManualAdMappingSchema = z.object({
  productId: z.string().uuid(),
  variantId: z.string().uuid().nullable().optional(),
});

export const tiktokMappingCatalogItemParamsSchema = z.object({
  catalogItemId: z.string().uuid(),
});

export const tiktokManualCatalogMappingSchema = z.object({
  variantId: z.string().uuid(),
});
