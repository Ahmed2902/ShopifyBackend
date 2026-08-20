import { z } from 'zod';

const shopifyMoneySchema = z.object({
  amount: z.string(),
  currencyCode: z.string().min(1),
});

export const shopifyMoneyBagSchema = z.object({
  shopMoney: shopifyMoneySchema,
  presentmentMoney: shopifyMoneySchema,
});

const pageInfoSchema = z.object({
  hasNextPage: z.boolean(),
  endCursor: z.string().nullable(),
});

const discountAllocationSchema = z
  .object({
    allocatedAmountSet: shopifyMoneyBagSchema,
  })
  .passthrough();

export const shopifyOrderLineItemSchema = z.object({
  id: z.string().min(1),
  sku: z.string().nullable().optional(),
  title: z.string(),
  variantTitle: z.string().nullable().optional(),
  quantity: z.number().int(),
  currentQuantity: z.number().int(),
  refundableQuantity: z.number().int().nullable().optional(),
  requiresShipping: z.boolean(),
  restockable: z.boolean(),
  product: z.object({ id: z.string().min(1) }).nullable().optional(),
  variant: z.object({ id: z.string().min(1) }).nullable().optional(),
  originalUnitPriceSet: shopifyMoneyBagSchema,
  originalTotalSet: shopifyMoneyBagSchema,
  discountedTotalSet: shopifyMoneyBagSchema,
  discountedUnitPriceAfterAllDiscountsSet: shopifyMoneyBagSchema,
  totalDiscountSet: shopifyMoneyBagSchema,
  discountAllocations: z.array(discountAllocationSchema).default([]),
});

export const shopifyOrderLineItemConnectionSchema = z.object({
  nodes: z.array(shopifyOrderLineItemSchema),
  pageInfo: pageInfoSchema,
});

export const shopifyRefundLineItemSchema = z.object({
  id: z.string().min(1).nullable().optional(),
  quantity: z.number().int(),
  restocked: z.boolean(),
  restockType: z.string().min(1),
  lineItem: z.object({ id: z.string().min(1) }),
  location: z.object({ id: z.string().min(1) }).nullable().optional(),
  priceSet: shopifyMoneyBagSchema,
  subtotalSet: shopifyMoneyBagSchema,
  totalTaxSet: shopifyMoneyBagSchema,
});

export const shopifyRefundLineItemConnectionSchema = z.object({
  nodes: z.array(shopifyRefundLineItemSchema),
  pageInfo: pageInfoSchema,
});

export const shopifyRefundSchema = z.object({
  id: z.string().min(1),
  createdAt: z.string().datetime().nullable().optional(),
  processedAt: z.string().datetime().nullable().optional(),
  updatedAt: z.string().datetime().nullable().optional(),
  totalRefundedSet: shopifyMoneyBagSchema,
  refundLineItems: shopifyRefundLineItemConnectionSchema,
});

export const shopifyOrderSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  createdAt: z.string().datetime(),
  processedAt: z.string().datetime().nullable().optional(),
  updatedAt: z.string().datetime().nullable().optional(),
  cancelledAt: z.string().datetime().nullable().optional(),
  cancelReason: z.string().nullable().optional(),
  sourceName: z.string().nullable().optional(),
  test: z.boolean(),
  currencyCode: z.string().min(1),
  presentmentCurrencyCode: z.string().min(1).nullable().optional(),
  displayFinancialStatus: z.string().nullable().optional(),
  displayFulfillmentStatus: z.string().nullable().optional(),
  currentSubtotalLineItemsQuantity: z.number().int().nullable().optional(),
  currentSubtotalPriceSet: shopifyMoneyBagSchema,
  currentShippingPriceSet: shopifyMoneyBagSchema,
  currentTotalDiscountsSet: shopifyMoneyBagSchema,
  currentTotalTaxSet: shopifyMoneyBagSchema,
  currentTotalPriceSet: shopifyMoneyBagSchema,
  discountCodes: z.array(z.string()).default([]),
  lineItems: shopifyOrderLineItemConnectionSchema,
  refunds: z.array(shopifyRefundSchema).default([]),
});

export const shopifyOrderConnectionSchema = z.object({
  nodes: z.array(shopifyOrderSchema),
  pageInfo: pageInfoSchema,
});

export type ShopifyMoneyBag = z.infer<typeof shopifyMoneyBagSchema>;
export type ShopifyOrder = z.infer<typeof shopifyOrderSchema>;
export type ShopifyOrderLineItem = z.infer<typeof shopifyOrderLineItemSchema>;
export type ShopifyRefund = z.infer<typeof shopifyRefundSchema>;
export type ShopifyRefundLineItem = z.infer<typeof shopifyRefundLineItemSchema>;
