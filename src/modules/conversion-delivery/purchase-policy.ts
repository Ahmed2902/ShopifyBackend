import { z } from 'zod';

export const PURCHASE_POLICY = 'COMPLETED_SHOPIFY_CHECKOUT_V1';
export const MAX_PURCHASE_ITEMS = 100;
const money = z.string().regex(/^\d+(?:\.\d{1,6})?$/).max(30);
const item = z.object({
  variantExternalId: z.string().regex(/^gid:\/\/shopify\/ProductVariant\/\d+$/),
  quantity: z.number().int().positive(),
  itemPrice: money.optional(),
});
export const purchaseFactsSchema = z.object({
  version: z.literal(1),
  policy: z.literal(PURCHASE_POLICY),
  eventAt: z.iso.datetime(),
  value: money,
  currencyCode: z.string().regex(/^[A-Z]{3}$/),
  items: z.array(item).max(MAX_PURCHASE_ITEMS),
  truncated: z.boolean(),
});
export type PurchaseFacts = z.infer<typeof purchaseFactsSchema>;

export function readPurchaseFacts(value: unknown): PurchaseFacts | null {
  const result = purchaseFactsSchema.safeParse(value);
  if (!result.success) return null;
  const digits = new Intl.NumberFormat('en', { style: 'currency', currency: result.data.currencyCode }).resolvedOptions().maximumFractionDigits;
  if ((result.data.value.split('.')[1]?.replace(/0+$/, '').length ?? 0) > (digits ?? 2)) return null;
  return result.data;
}

export function purchaseEligibility(input: {
  sourceName: string | null;
  isB2B: boolean;
  cancelledAt: Date | null;
  isTest: boolean;
  testOnly?: boolean;
  checkoutLinked: boolean;
  installedAt: Date;
  facts: PurchaseFacts | null;
}) {
  if (input.isTest !== (input.testOnly === true)) return 'TEST_ORDER';
  if (input.cancelledAt) return 'ORDER_CANCELLED';
  const source = input.sourceName?.toLowerCase();
  if (source !== 'web') return 'ORDER_SOURCE_EXCLUDED';
  if (input.isB2B) return 'B2B_ORDER_EXCLUDED';
  if (!input.checkoutLinked) return 'CHECKOUT_LINK_UNAVAILABLE';
  if (!input.facts) return 'PURCHASE_FACTS_UNAVAILABLE';
  if (new Date(input.facts.eventAt) < input.installedAt) return 'ORDER_BEFORE_INSTALLATION';
  if (Number(input.facts.value) <= 0) return 'ZERO_VALUE_ORDER';
  // Financial and fulfillment status deliberately do not gate a completed COD checkout.
  return null;
}

// Store only commerce facts. Customer fields and catalog mappings are resolved separately.
export function canonicalPurchaseFacts(order: {
  createdAt: string;
  processedAt?: string | null;
  originalTotalPriceSet?: { shopMoney: { amount: string; currencyCode: string } };
  currentTotalPriceSet: { shopMoney: { amount: string; currencyCode: string } };
  lineItems: Array<{
    variant?: { id: string } | null;
    quantity: number;
    discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: string; currencyCode: string } };
  }>;
  edited?: boolean;
}): PurchaseFacts | null {
  const total = order.originalTotalPriceSet?.shopMoney ?? order.currentTotalPriceSet.shopMoney;
  const items = (order.edited ? [] : order.lineItems).flatMap(line => {
    if (!line.variant?.id || line.quantity < 1) return [];
    const price = line.discountedUnitPriceAfterAllDiscountsSet.shopMoney;
    return [{ variantExternalId: line.variant.id, quantity: line.quantity,
      ...(price.currencyCode === total.currencyCode ? { itemPrice: price.amount } : {}) }];
  });
  return readPurchaseFacts({ version: 1, policy: PURCHASE_POLICY,
    eventAt: order.processedAt ?? order.createdAt, value: total.amount,
    currencyCode: total.currencyCode, items: items.slice(0, MAX_PURCHASE_ITEMS),
    truncated: order.edited === true || items.length > MAX_PURCHASE_ITEMS || items.length < order.lineItems.length });
}
