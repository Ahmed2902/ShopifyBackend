import { z } from 'zod';

const shopifyIdSchema = z.union([z.string().min(1), z.number().int().nonnegative()]);

const shopIdentitySchema = z.object({
  shop_id: shopifyIdSchema,
  shop_domain: z.string().min(1),
});

const customerIdentitySchema = z.object({
  id: shopifyIdSchema,
  // Shopify includes these fields in compliance payloads. Stride validates their shape but
  // deliberately drops them before writing the durable webhook inbox.
  email: z.string().nullable().optional(),
  phone: z.string().nullable().optional(),
});

export const shopifyCustomerDataRequestSchema = shopIdentitySchema.extend({
  customer: customerIdentitySchema,
  orders_requested: z.array(shopifyIdSchema).default([]),
  data_request: z.object({ id: shopifyIdSchema }).passthrough().optional(),
}).passthrough();

export const shopifyCustomerRedactSchema = shopIdentitySchema.extend({
  customer: customerIdentitySchema,
  orders_to_redact: z.array(shopifyIdSchema).default([]),
}).passthrough();

export const shopifyShopRedactSchema = shopIdentitySchema.passthrough();

export const shopifyCustomerDataRequestInboxSchema = z.object({
  shop_id: z.string().min(1),
  shop_domain: z.string().min(1),
  orders_requested: z.array(z.string().min(1)),
  data_request_id: z.string().nullable(),
});

export const shopifyCustomerRedactInboxSchema = z.object({
  shop_id: z.string().min(1),
  shop_domain: z.string().min(1),
  orders_to_redact: z.array(z.string().min(1)),
});

export const shopifyShopRedactInboxSchema = z.object({
  shop_id: z.string().min(1),
  shop_domain: z.string().min(1),
});

export const SHOPIFY_COMPLIANCE_TOPICS = [
  'customers/data_request',
  'customers/redact',
  'shop/redact',
] as const;

export type ShopifyComplianceTopic = (typeof SHOPIFY_COMPLIANCE_TOPICS)[number];

export function isShopifyComplianceTopic(topic: string): topic is ShopifyComplianceTopic {
  return (SHOPIFY_COMPLIANCE_TOPICS as readonly string[]).includes(topic);
}

export function shopifyExternalOrderId(value: string | number): string {
  const text = String(value);
  return text.startsWith('gid://shopify/Order/') ? text : `gid://shopify/Order/${text}`;
}
