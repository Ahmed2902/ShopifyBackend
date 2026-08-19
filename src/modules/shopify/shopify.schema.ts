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

export const shopifyProfileResponseSchema = z.object({
  data: z.object({ shop: shopifyProfileSchema }).optional(),
  errors: z.array(z.object({ message: z.string() })).optional(),
});

export type ShopifyShopProfile = z.infer<typeof shopifyProfileSchema>;
