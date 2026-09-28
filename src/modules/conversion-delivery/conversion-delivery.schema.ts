import { z } from 'zod';

export const conversionProviderSchema = z.enum(['META', 'TIKTOK', 'GOOGLE_ADS']);

export const configureConversionDestinationSchema = z
  .object({
    provider: conversionProviderSchema,
    accountExternalId: z.string().trim().min(1).max(128),
    destinationExternalId: z.string().trim().min(1).max(256),
    accessToken: z.string().trim().min(8).max(8192).optional(),
    testEventCode: z.string().trim().min(1).max(128).nullable().optional(),
  })
  .strict();

export const conversionDestinationParamsSchema = z.object({
  storeId: z.string().uuid(),
  destinationId: z.string().uuid(),
});

export const conversionDeliveryParamsSchema = z.object({
  storeId: z.string().uuid(),
  deliveryId: z.string().uuid(),
});

export const conversionDeliveryListQuerySchema = z
  .object({
    destinationId: z.string().uuid().optional(),
    status: z.enum(['PENDING', 'PROCESSING', 'RETRYING', 'SENT', 'DEAD']).optional(),
    page: z.coerce.number().int().min(1).default(1),
    limit: z.coerce.number().int().min(1).max(100).default(25),
  })
  .strict();
