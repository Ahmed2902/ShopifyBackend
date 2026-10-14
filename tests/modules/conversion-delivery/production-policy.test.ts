import { describe, expect, it } from 'vitest';
import { canonicalPurchaseFacts, purchaseEligibility, readPurchaseFacts, PURCHASE_POLICY } from '../../../src/modules/conversion-delivery/purchase-policy.js';
import { deliveryDeadline, retryAfterMs, retryDelayMs } from '../../../src/modules/conversion-delivery/delivery-policy.js';
import { cartProofHash, signCartReceipt, verifyCartReceipt } from '../../../src/modules/conversion-delivery/cart-recovery.js';
import { lineAdjustment } from '../../../src/modules/shopify/order/order-adjustments.js';
const store = '00000000-0000-4000-8000-000000000001';
const event = '00000000-0000-4000-8000-000000000002';
const facts = { version: 1, policy: PURCHASE_POLICY, eventAt: '2026-10-14T12:00:00.000Z', value: '100.00', currencyCode: 'USD', items: [], truncated: false };
describe('completed checkout policy', () => {
  const input = { sourceName: 'web', isB2B: false, cancelledAt: null, isTest: false,
    checkoutLinked: true, installedAt: new Date('2026-10-01'), facts: readPurchaseFacts(facts) };
  it('allows a completed deferred-payment checkout without requiring payment or shipment status', () => {
    expect(purchaseEligibility(input)).toBeNull();
    expect(purchaseEligibility({ ...input, sourceName: 'pos' })).toBe('ORDER_SOURCE_EXCLUDED');
    expect(purchaseEligibility({ ...input, sourceName: 'subscription_contract' })).toBe('ORDER_SOURCE_EXCLUDED');
    expect(purchaseEligibility({ ...input, isB2B: true })).toBe('B2B_ORDER_EXCLUDED');
  });
  it('withholds unverified, cancelled, test, pre-install and zero-value orders', () => {
    expect(purchaseEligibility({ ...input, checkoutLinked: false })).toBe('CHECKOUT_LINK_UNAVAILABLE');
    expect(purchaseEligibility({ ...input, cancelledAt: new Date() })).toBe('ORDER_CANCELLED');
    expect(purchaseEligibility({ ...input, isTest: true })).toBe('TEST_ORDER');
    expect(purchaseEligibility({ ...input, installedAt: new Date('2026-10-15') })).toBe('ORDER_BEFORE_INSTALLATION');
    expect(purchaseEligibility({ ...input, facts: readPurchaseFacts({ ...facts, value: '0' }) })).toBe('ZERO_VALUE_ORDER');
  });
  it('takes original shop money rather than edited totals or presentment labels', () => {
    const f = canonicalPurchaseFacts({ createdAt: facts.eventAt, originalTotalPriceSet: { shopMoney: { amount: '100', currencyCode: 'JPY' } },
      currentTotalPriceSet: { shopMoney: { amount: '20', currencyCode: 'JPY' } },
      lineItems: [{ variant: { id: 'gid://shopify/ProductVariant/12' }, quantity: 2,
        discountedUnitPriceAfterAllDiscountsSet: { shopMoney: { amount: '50', currencyCode: 'JPY' } } }] });
    expect(f).toMatchObject({ value: '100', currencyCode: 'JPY', items: [{ quantity: 2, itemPrice: '50' }] });
  });
});
describe('return and refund reporting', () => {
  it('deducts a removal once, including when a later refund describes the same units', () => {
    const base = { quantity: 4, currentQuantity: 2, productRevenue: 100, refundedUnits: 0, refundedValue: 0 };
    expect(lineAdjustment(base)).toEqual({ units: 2, value: 50 });
    expect(lineAdjustment({ ...base, refundedUnits: 2, refundedValue: 50 })).toEqual({ units: 2, value: 50 });
    expect(lineAdjustment({ ...base, currentQuantity: 0, refundedUnits: 4, refundedValue: 100 })).toEqual({ units: 4, value: 100 });
  });
  it('keeps a monetary adjustment without multiplying it by returned quantity', () => {
    expect(lineAdjustment({ quantity: 2, currentQuantity: 2, productRevenue: 80, refundedUnits: 0, refundedValue: 10 })).toEqual({ units: 0, value: 10 });
  });
});
describe('retry deadlines and headers', () => {
  it('uses the original event clock and honors numeric and HTTP-date Retry-After', () => {
    const now = +new Date(facts.eventAt);
    expect(retryAfterMs('120', now)).toBe(120000);
    expect(retryAfterMs('Wed, 14 Oct 2026 12:02:00 GMT', now)).toBe(120000);
    expect(retryAfterMs('invalid', now)).toBeUndefined();
    expect(retryDelayMs(1, 120000, () => 0)).toBe(120000);
    expect(retryDelayMs(1, undefined, () => 0)).toBe(30000);
    expect(+deliveryDeadline('META', new Date(facts.eventAt))).toBe(now + 7 * 86400000 - 300000);
  });
});
describe('cart receipt integrity', () => {
  const token = 'opaque_cart_12345678901234567890';
  const receipt = signCartReceipt({ v: 1, storeId: store, eventId: event, cartHash: cartProofHash(store, token)!,
    generation: facts.eventAt, expires: Date.now() + 60000 });
  it('requires the canonical cart, tenant, signature and unexpired lifetime', () => {
    expect(verifyCartReceipt(receipt, store, token)?.eventId).toBe(event);
    expect(verifyCartReceipt(receipt, store, token + 'other')).toBeNull();
    expect(verifyCartReceipt(receipt, event, token)).toBeNull();
    expect(verifyCartReceipt(receipt + 'x', store, token)).toBeNull();
    expect(verifyCartReceipt(receipt, store, token, Date.now() + 120000)).toBeNull();
    expect(cartProofHash(store, token + '?key=secret')).toBe(cartProofHash(store, token));
  });
});
