import { z } from 'zod';

const optionalString = z.string().optional().nullable();
const optionalCount = z.coerce.number().int().nonnegative().optional().nullable();

export const metaProductCatalogSchema = z
  .object({
    id: z.string().min(1),
    name: z.string().min(1),
    business: z.object({ id: z.string().min(1), name: z.string().optional() }).optional().nullable(),
    owner_business: z
      .object({ id: z.string().min(1), name: z.string().optional() })
      .optional()
      .nullable(),
    vertical: optionalString,
    product_count: optionalCount,
    feed_count: optionalCount,
  })
  .passthrough();

export const metaCatalogItemSchema = z
  .object({
    id: z.string().min(1),
    retailer_id: optionalString,
    retailer_product_group_id: optionalString,
    parent_product_id: optionalString,
    name: optionalString,
    brand: optionalString,
    availability: optionalString,
    price: z.union([z.string(), z.number()]).optional().nullable(),
    sale_price: z.union([z.string(), z.number()]).optional().nullable(),
    currency: optionalString,
    size: optionalString,
    color: optionalString,
    pattern: optionalString,
    url: optionalString,
    product_type: optionalString,
    custom_label_0: optionalString,
    custom_label_1: optionalString,
    custom_label_2: optionalString,
    custom_label_3: optionalString,
    custom_label_4: optionalString,
    product_feed: z.object({ id: z.string().min(1) }).optional().nullable(),
    quantity_to_sell_on_facebook: z.coerce.number().int().optional().nullable(),
    status: optionalString,
    visibility: optionalString,
  })
  .passthrough();

export type MetaProductCatalogPayload = z.infer<typeof metaProductCatalogSchema>;
export type MetaCatalogItemPayload = z.infer<typeof metaCatalogItemSchema>;
