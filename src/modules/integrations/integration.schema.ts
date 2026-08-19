import { z } from 'zod';

export const integrationStoreParamsSchema = z.object({
  storeId: z.string().uuid(),
});

export const syncRunQuerySchema = z.object({
  provider: z.enum(['SHOPIFY', 'META']).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type IntegrationProviderName = 'SHOPIFY' | 'META';
