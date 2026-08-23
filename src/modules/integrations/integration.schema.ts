import { z } from 'zod';

export const INTEGRATION_PROVIDERS = ['SHOPIFY', 'META', 'TIKTOK'] as const;

export const syncRunQuerySchema = z.object({
  provider: z.enum(INTEGRATION_PROVIDERS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type IntegrationProviderName = (typeof INTEGRATION_PROVIDERS)[number];
