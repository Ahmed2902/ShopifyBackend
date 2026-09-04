import { describe, expect, it } from 'vitest';
import {
  aggregateMeta,
  aggregateOrders,
  aggregateProducts,
  aggregateVariantUnits,
  metricChanges,
} from '../../../src/modules/analytics/analytics.metrics.js';

describe('analytics metrics', () => {
  it('counts non-restocked refunds as inventory depletion', () => {
    const units = aggregateVariantUnits([
      {
        variantId: 'variant-1',
        quantity: 10,
        refundLines: [
          { quantity: 2, restocked: true },
          { quantity: 3, restocked: false },
        ],
      },
    ]);

    expect(units.get('variant-1')).toBe(8);
  });

  it('does not subtract refunds twice from Shopify current order value', () => {
    const result = aggregateOrders(
      [
        {
          id: 'order-1',
          shopifyCreatedAt: new Date('2026-09-01T10:00:00.000Z'),
          processedAt: new Date('2026-09-01T10:00:00.000Z'),
          currencyCode: 'USD',
          currentSubtotalLineItemsQuantity: 1,
          currentTotalAmount: 80,
          currentTotalDiscountsAmount: 0,
          customerOrderIndex: 1,
          customerJourneyReady: true,
          refunds: [{ totalRefunded: 20, currencyCode: 'USD' }],
        },
      ] as unknown as Parameters<typeof aggregateOrders>[0],
      'USD',
    );

    expect(result.orderValue).toBe(80);
    expect(result.refunds).toBe(20);
    expect(result.netOrderValue).toBe(80);
    expect(result.aov).toBe(80);
  });

  it('nets product refunds but reverses COGS only for restocked units', () => {
    const at = new Date('2026-09-01T10:00:00.000Z');
    const result = aggregateProducts(
      [
        {
          productId: 'product-1',
          variantId: 'variant-1',
          quantity: 3,
          currentQuantity: 1,
          discountedTotal: 300,
          order: {
            id: 'order-1',
            shopifyCreatedAt: at,
            processedAt: at,
            currencyCode: 'USD',
          },
          product: {
            id: 'product-1',
            shopifyProductId: 'gid://shopify/Product/1',
            title: 'Core Tee',
            productType: null,
            vendor: null,
            status: 'ACTIVE',
          },
          variant: {
            id: 'variant-1',
            shopifyVariantId: 'gid://shopify/ProductVariant/1',
            title: 'Default',
            sku: 'TEE',
          },
          refundLines: [
            { quantity: 1, subtotal: 100, restocked: true },
            { quantity: 1, subtotal: 100, restocked: false },
          ],
        },
      ] as unknown as Parameters<typeof aggregateProducts>[0],
      [
        {
          variantId: 'variant-1',
          amount: 40,
          currency: 'USD',
          effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
          effectiveUntil: null,
        },
      ] as unknown as Parameters<typeof aggregateProducts>[1],
      'USD',
    ).get('product-1');

    expect(result).toMatchObject({
      soldUnits: 3,
      refundedUnits: 2,
      netUnits: 1,
      productRevenue: 300,
      refunds: 200,
      netProductRevenue: 100,
      cogs: 80,
      costCoverage: 1,
      contributionBeforeAds: 20,
    });
  });

  it('uses one prioritized purchase action family instead of double-counting Meta purchase values', () => {
    const result = aggregateMeta([
      {
        spend: 100,
        impressions: 1_000n,
        clicks: 100n,
        frequency: 1.5,
        actions: [
          {
            kind: 'ACTION',
            actionType: 'offsite_conversion.fb_pixel_purchase',
            actionDestination: null,
            value: 2,
          },
          {
            kind: 'ACTION',
            actionType: 'purchase',
            actionDestination: null,
            value: 5,
          },
          {
            kind: 'ACTION_VALUE',
            actionType: 'offsite_conversion.fb_pixel_purchase',
            actionDestination: null,
            value: 200,
          },
          {
            kind: 'ACTION_VALUE',
            actionType: 'purchase',
            actionDestination: null,
            value: 500,
          },
        ],
      },
    ] as unknown as Parameters<typeof aggregateMeta>[0]);

    expect(result.purchases).toBe(2);
    expect(result.purchaseValue).toBe(200);
    expect(result.providerRoas).toBe(2);
  });

  it('keeps relative change undefined when the comparison baseline is zero', () => {
    expect(
      metricChanges(
        { spend: 100, roas: 2 },
        { spend: 0, roas: 1 },
      ),
    ).toEqual({ spend: null, roas: 1 });
  });
});
