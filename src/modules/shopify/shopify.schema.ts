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
  expires_in: z.number().int().positive(),
  refresh_token: z.string().min(1),
  refresh_token_expires_in: z.number().int().positive(),
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

export const shopifyProductSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  handle: z.string().nullable().optional(),
  productType: z.string().nullable().optional(),
  vendor: z.string().nullable().optional(),
  tags: z.array(z.string()).default([]),
  status: z.string(),
  totalInventory: z.number().int().nullable().optional(),
  tracksInventory: z.boolean().default(false),
  publishedAt: z.string().datetime().nullable().optional(),
  createdAt: z.string().datetime().nullable().optional(),
  updatedAt: z.string().datetime().nullable().optional(),
});

const shopifyMoneyV2Schema = z.object({
  amount: z.string(),
  currencyCode: z.string().min(1),
});

export const shopifyInventoryItemSchema = z.object({
  id: z.string().min(1),
  sku: z.string().nullable().optional(),
  tracked: z.boolean(),
  requiresShipping: z.boolean(),
  unitCost: shopifyMoneyV2Schema.nullable().optional(),
  createdAt: z.string().datetime().nullable().optional(),
  updatedAt: z.string().datetime().nullable().optional(),
});

export const shopifySelectedOptionSchema = z.object({
  name: z.string().min(1),
  value: z.string(),
});

export const shopifyVariantSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  displayName: z.string().nullable().optional(),
  sku: z.string().nullable().optional(),
  barcode: z.string().nullable().optional(),
  price: z.string().nullable().optional(),
  compareAtPrice: z.string().nullable().optional(),
  position: z.number().int().nullable().optional(),
  availableForSale: z.boolean(),
  inventoryQuantity: z.number().int().nullable().optional(),
  inventoryPolicy: z.string().nullable().optional(),
  createdAt: z.string().datetime().nullable().optional(),
  updatedAt: z.string().datetime().nullable().optional(),
  selectedOptions: z.array(shopifySelectedOptionSchema).default([]),
  product: z.object({ id: z.string().min(1) }),
  inventoryItem: shopifyInventoryItemSchema,
});

export const shopifyCollectionSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  handle: z.string().nullable().optional(),
  descriptionHtml: z.string().nullable().optional(),
  sortOrder: z.string().nullable().optional(),
  image: z.object({ url: z.string().url() }).nullable().optional(),
  updatedAt: z.string().datetime().nullable().optional(),
});

export const shopifyCollectionProductSchema = z.object({
  id: z.string().min(1),
});

export const shopifyLocationSchema = z.object({
  id: z.string().min(1),
  name: z.string(),
  isActive: z.boolean(),
  fulfillsOnlineOrders: z.boolean().nullable().optional(),
  shipsInventory: z.boolean().nullable().optional(),
  hasActiveInventory: z.boolean().nullable().optional(),
  deactivatedAt: z.string().datetime().nullable().optional(),
  address: z
    .object({
      address1: z.string().nullable().optional(),
      address2: z.string().nullable().optional(),
      city: z.string().nullable().optional(),
      country: z.string().nullable().optional(),
      countryCode: z.string().nullable().optional(),
      province: z.string().nullable().optional(),
      provinceCode: z.string().nullable().optional(),
      zip: z.string().nullable().optional(),
      phone: z.string().nullable().optional(),
    })
    .passthrough()
    .nullable()
    .optional(),
  createdAt: z.string().datetime().nullable().optional(),
  updatedAt: z.string().datetime().nullable().optional(),
});

export const shopifyInventoryQuantitySchema = z.object({
  name: z.string().min(1),
  quantity: z.number().int(),
});

export const shopifyInventoryLevelSchema = z.object({
  id: z.string().min(1),
  updatedAt: z.string().datetime().nullable().optional(),
  item: z.object({ id: z.string().min(1) }),
  location: z.object({ id: z.string().min(1) }),
  quantities: z.array(shopifyInventoryQuantitySchema),
});

const pageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});

export const shopifyProductConnectionSchema = z.object({
  nodes: z.array(shopifyProductSchema),
  pageInfo: pageInfoSchema,
});

export const shopifyVariantConnectionSchema = z.object({
  nodes: z.array(shopifyVariantSchema),
  pageInfo: pageInfoSchema,
});

export const shopifyCollectionConnectionSchema = z.object({
  nodes: z.array(shopifyCollectionSchema),
  pageInfo: pageInfoSchema,
});

export const shopifyCollectionProductConnectionSchema = z.object({
  nodes: z.array(shopifyCollectionProductSchema),
  pageInfo: pageInfoSchema,
});

export const shopifyLocationConnectionSchema = z.object({
  nodes: z.array(shopifyLocationSchema),
  pageInfo: pageInfoSchema,
});

export const shopifyInventoryLevelConnectionSchema = z.object({
  nodes: z.array(shopifyInventoryLevelSchema),
  pageInfo: pageInfoSchema,
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

export type ShopifyAccessTokenResponse = z.infer<typeof shopifyAccessTokenSchema>;
export type ShopifyShopProfile = z.infer<typeof shopifyProfileSchema>;
export type ShopifyProduct = z.infer<typeof shopifyProductSchema>;
export type ShopifyVariant = z.infer<typeof shopifyVariantSchema>;
export type ShopifyCollection = z.infer<typeof shopifyCollectionSchema>;
export type ShopifyLocation = z.infer<typeof shopifyLocationSchema>;
export type ShopifyInventoryLevel = z.infer<typeof shopifyInventoryLevelSchema>;
export type ShopifyGraphqlResponse = z.infer<typeof shopifyGraphqlResponseSchema>;
export type ShopifyGraphqlCost = z.infer<typeof shopifyGraphqlCostSchema>;
