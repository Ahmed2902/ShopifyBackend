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

const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function validDateOnly(value: string): boolean {
  if (!DATE_PATTERN.test(value)) return false;
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}

const productSalesBoundarySchema = z.string().refine(
  (value) => validDateOnly(value) || !Number.isNaN(Date.parse(value)),
  'Expected a valid YYYY-MM-DD date or ISO datetime',
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

export const shopifyProductSalesQuerySchema = z
  .object({
    from: productSalesBoundarySchema.optional(),
    to: productSalesBoundarySchema.optional(),
    days: z.coerce.number().int().min(1).max(365).default(30),
  })
  .refine((query) => Boolean(query.from) === Boolean(query.to), {
    message: 'from and to must be provided together',
  })
  .refine(
    (query) => !query.from || !query.to || new Date(query.from.length === 10 ? `${query.from}T00:00:00.000Z` : query.from) <= new Date(query.to.length === 10 ? `${query.to}T00:00:00.000Z` : query.to),
    { message: '`from` must be before or equal to `to`', path: ['from'] },
  )
  .refine(
    (query) => !query.from || !query.to || (query.from.length === 10) === (query.to.length === 10),
    { message: 'from and to must use the same date format' },
  );

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