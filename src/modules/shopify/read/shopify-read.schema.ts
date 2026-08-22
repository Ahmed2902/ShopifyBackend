import { z } from 'zod';

const pageSchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  limit: z.coerce.number().int().min(1).max(100).default(50),
});

const optionalText = z.string().trim().min(1).max(200).optional();

const dateRangeSchema = z
  .object({
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .refine(
    (query) => !query.from || !query.to || new Date(query.from) <= new Date(query.to),
    {
      message: '`from` must be before or equal to `to`',
      path: ['from'],
    },
  );

export const shopifyProductsQuerySchema = pageSchema.extend({
  q: optionalText,
  status: optionalText,
  vendor: optionalText,
});

export const shopifyInventoryQuerySchema = pageSchema.extend({
  q: optionalText,
  locationId: z.string().uuid().optional(),
  lowStockBelow: z.coerce.number().int().min(0).optional(),
});

export const shopifyOrdersQuerySchema = pageSchema
  .extend({
    q: optionalText,
    financialStatus: optionalText,
    fulfillmentStatus: optionalText,
    sourceName: optionalText,
    isTest: z.enum(['true', 'false']).transform((value) => value === 'true').optional(),
    from: z.string().datetime().optional(),
    to: z.string().datetime().optional(),
  })
  .refine(
    (query) => !query.from || !query.to || new Date(query.from) <= new Date(query.to),
    {
      message: '`from` must be before or equal to `to`',
      path: ['from'],
    },
  );

export const shopifySummaryQuerySchema = dateRangeSchema.and(
  z.object({ lowStockBelow: z.coerce.number().int().min(0).max(100000).default(5) }),
);

export const shopifyProductSalesQuerySchema = dateRangeSchema;

export const shopifyProductParamsSchema = z.object({
  productId: z.string().uuid(),
});

export const shopifyOrderParamsSchema = z.object({
  orderId: z.string().uuid(),
});

export type ShopifyProductsQuery = z.infer<typeof shopifyProductsQuerySchema>;
export type ShopifyInventoryQuery = z.infer<typeof shopifyInventoryQuerySchema>;
export type ShopifyOrdersQuery = z.infer<typeof shopifyOrdersQuerySchema>;
export type ShopifySummaryQuery = z.infer<typeof shopifySummaryQuerySchema>;
export type ShopifyProductSalesQuery = z.infer<typeof shopifyProductSalesQuerySchema>;
