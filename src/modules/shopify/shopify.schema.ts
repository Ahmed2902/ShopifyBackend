import { z } from 'zod';

export const shopifyInstallSchema = z.object({
  shop: z.string().trim().min(1).max(255),
});

export const shopifyCallbackSchema = z.object({
  code: z.string().min(1),
  shop: z.string().min(1),
  state: z.string().min(1),
  hmac: z.string().min(1),
  timestamp: z.string().min(1),
});

export const shopifyAccessTokenSchema = z.object({
  access_token: z.string().min(1),
  scope: z.string().default(''),
});

export const shopifyProfileSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  myshopifyDomain: z.string().min(1),
  currencyCode: z.string().min(1),
  ianaTimezone: z.string().min(1),
  primaryDomain: z.object({ host: z.string().min(1), url: z.string().url() }).nullable(),
  enabledPresentmentCurrencies: z.array(z.string()),
  createdAt: z.string().datetime(),
});

const shopifyGraphqlErrorSchema = z.object({
  message: z.string(),
  extensions: z
    .object({
      code: z.string().optional(),
    })
    .passthrough()
    .optional(),
});

const shopifyThrottleStatusSchema = z.object({
  maximumAvailable: z.number(),
  currentlyAvailable: z.number(),
  restoreRate: z.number(),
});

const shopifyGraphqlCostSchema = z.object({
  requestedQueryCost: z.number().optional(),
  actualQueryCost: z.number().optional(),
  throttleStatus: shopifyThrottleStatusSchema.optional(),
});

export const shopifyGraphqlResponseSchema = z
  .object({
    data: z.unknown().optional(),
    errors: z.array(shopifyGraphqlErrorSchema).optional(),
    extensions: z
      .object({
        cost: shopifyGraphqlCostSchema.optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

export const shopifyProfileResponseSchema = z.object({
  data: z.object({ shop: shopifyProfileSchema }).optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

export type ShopifyShopProfile = z.infer<typeof shopifyProfileSchema>;
export type ShopifyGraphqlResponse = z.infer<typeof shopifyGraphqlResponseSchema>;
export type ShopifyGraphqlCost = z.infer<typeof shopifyGraphqlCostSchema>;
