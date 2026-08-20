import { z } from 'zod';

const shopifyWebhookIdSchema = z.union([z.string().min(1), z.number().int().nonnegative()]);

export const shopifyWebhookHeadersSchema = z.object({
  hmac: z.string().min(1),
  topic: z.string().min(1),
  shopDomain: z.string().min(1),
  webhookId: z.string().min(1),
  apiVersion: z.string().min(1).optional(),
  triggeredAt: z.string().datetime().optional(),
});

export const shopifyResourceWebhookSchema = z
  .object({
    id: shopifyWebhookIdSchema,
    admin_graphql_api_id: z.string().min(1).optional(),
  })
  .passthrough();

export const shopifyRefundWebhookSchema = z
  .object({
    id: shopifyWebhookIdSchema,
    admin_graphql_api_id: z.string().min(1).optional(),
    order_id: shopifyWebhookIdSchema,
  })
  .passthrough();

export const shopifyInventoryLevelWebhookSchema = z
  .object({
    inventory_item_id: shopifyWebhookIdSchema,
    location_id: shopifyWebhookIdSchema,
  })
  .passthrough();

export const shopifyBulkOperationWebhookSchema = z
  .object({
    id: shopifyWebhookIdSchema.optional(),
    admin_graphql_api_id: z.string().min(1).optional(),
    status: z.string().optional(),
    error_code: z.string().nullable().optional(),
  })
  .passthrough()
  .refine((value) => Boolean(value.admin_graphql_api_id ?? value.id), {
    message: 'Bulk operation webhook is missing its resource ID',
  });

const webhookSubscriptionNodeSchema = z.object({
  id: z.string().min(1),
  topic: z.string().min(1),
  uri: z.string().min(1),
});

const pageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});

export const webhookSubscriptionsSchema = z.object({
  webhookSubscriptions: z.object({
    nodes: z.array(webhookSubscriptionNodeSchema),
    pageInfo: pageInfoSchema,
  }),
});

const webhookSubscriptionMutationPayloadSchema = z.object({
  webhookSubscription: webhookSubscriptionNodeSchema.nullable(),
  userErrors: z.array(
    z.object({
      field: z.array(z.string()).nullable().optional(),
      message: z.string(),
    }),
  ),
});

export const webhookSubscriptionCreateSchema = z.object({
  webhookSubscriptionCreate: webhookSubscriptionMutationPayloadSchema,
});

export const webhookSubscriptionUpdateSchema = z.object({
  webhookSubscriptionUpdate: webhookSubscriptionMutationPayloadSchema,
});

export type ShopifyWebhookHeaders = z.infer<typeof shopifyWebhookHeadersSchema>;
export type ShopifyWebhookSubscriptionNode = z.infer<typeof webhookSubscriptionNodeSchema>;
