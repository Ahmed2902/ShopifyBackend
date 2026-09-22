import { z } from 'zod';

/**
 * Advertising integrations supported by Stride's normalized paid-media layer.
 * Keep this list as the single runtime source for ad-provider validation.
 */
export const ADVERTISING_PROVIDERS = ['META', 'TIKTOK'] as const;
export type AdProviderName = (typeof ADVERTISING_PROVIDERS)[number];

export const INTEGRATION_PROVIDERS = ['SHOPIFY', ...ADVERTISING_PROVIDERS] as const;

export const syncRunQuerySchema = z.object({
  provider: z.enum(INTEGRATION_PROVIDERS).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

export type IntegrationProviderName = (typeof INTEGRATION_PROVIDERS)[number];
