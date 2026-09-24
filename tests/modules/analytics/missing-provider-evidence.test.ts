import { Prisma } from '../../../src/generated/prisma/client.js';
import { describe, expect, it } from 'vitest';
import { aggregateMeta } from '../../../src/modules/analytics/analytics.metrics.js';
import { buildProductAdsPeriod } from '../../../src/modules/analytics/product-ads.metrics.js';

function metricRow(input: {
  spend?: number;
  conversionsAvailable?: boolean;
  conversionValueAvailable?: boolean;
  purchases?: number;
  purchaseValue?: number;
}) {
  const actions = [] as Array<{
    kind: 'ACTION' | 'ACTION_VALUE';
    actionType: string;
    actionDestination: null;
    value: Prisma.Decimal;
  }>;
  if (input.conversionsAvailable !== false) {
    actions.push({
      kind: 'ACTION',
      actionType: 'offsite_conversion.fb_pixel_purchase',
      actionDestination: null,
      value: new Prisma.Decimal(input.purchases ?? 0),
    });
  }
  if (input.conversionValueAvailable !== false) {
    actions.push({
      kind: 'ACTION_VALUE',
      actionType: 'offsite_conversion.fb_pixel_purchase',
      actionDestination: null,
      value: new Prisma.Decimal(input.purchaseValue ?? 0),
    });
  }
  return {
    spend: new Prisma.Decimal(input.spend ?? 0),
    impressions: 100n,
    clicks: 10n,
    frequency: new Prisma.Decimal(1),
    actions,
    conversionsAvailable: input.conversionsAvailable,
    conversionValueAvailable: input.conversionValueAvailable,
  } as any;
}

describe('provider attribution availability', () => {
  it('keeps no evidence and null canonical evidence unavailable', () => {
    const none = aggregateMeta([]);
    expect(none.sourceRows).toBe(0);
    expect(none.purchases).toBeNull();
    expect(none.purchaseValue).toBeNull();
    expect(none.providerRoas).toBeNull();

    const unavailable = aggregateMeta([
      metricRow({ spend: 25, conversionsAvailable: false, conversionValueAvailable: false }),
    ]);
    expect(unavailable.sourceRows).toBe(1);
    expect(unavailable.purchases).toBeNull();
    expect(unavailable.purchaseValue).toBeNull();
    expect(unavailable.providerRoas).toBeNull();
  });

  it('preserves a genuine provider-reported zero', () => {
    const zero = aggregateMeta([
      metricRow({ spend: 25, purchases: 0, purchaseValue: 0 }),
    ]);
    expect(zero.sourceRows).toBe(1);
    expect(zero.purchases).toBe(0);
    expect(zero.purchaseValue).toBe(0);
    expect(zero.providerRoas).toBe(0);
  });

  it('fails closed when a period mixes available and unavailable attribution facts', () => {
    const mixed = aggregateMeta([
      metricRow({ spend: 25, purchases: 2, purchaseValue: 50 }),
      metricRow({ spend: 10, conversionsAvailable: false, conversionValueAvailable: false }),
    ]);
    expect(mixed.spend).toBe(35);
    expect(mixed.purchases).toBeNull();
    expect(mixed.purchaseValue).toBeNull();
    expect(mixed.providerRoas).toBeNull();
  });
});

describe('legacy Product x Ads evidence semantics', () => {
  const at = new Date('2026-09-20T12:00:00.000Z');
  const product = {
    id: '00000000-0000-4000-8000-000000000001',
    shopifyProductId: 'gid://shopify/Product/1',
    title: 'Product',
    productType: null,
    vendor: null,
    status: 'ACTIVE',
    deletedAt: null,
  };
  const commerceRow = {
    productId: product.id,
    variantId: '00000000-0000-4000-8000-000000000002',
    quantity: 1,
    currentQuantity: 1,
    discountedTotal: new Prisma.Decimal(100),
    order: {
      id: '00000000-0000-4000-8000-000000000003',
      shopifyCreatedAt: at,
      processedAt: at,
      currencyCode: 'USD',
    },
    product,
    variant: null,
    refundLines: [],
  } as any;
  const costRow = {
    variantId: commerceRow.variantId,
    amount: new Prisma.Decimal(40),
    currency: 'USD',
    effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
    effectiveUntil: null,
  } as any;
  const mapping = {
    metaAdId: '00000000-0000-4000-8000-000000000004',
    productId: product.id,
    variantId: null,
    source: 'MANUAL',
    confidence: new Prisma.Decimal(1),
    isMerchantConfirmed: true,
    product,
    variant: null,
    ad: { id: '00000000-0000-4000-8000-000000000004', name: 'Ad' },
  } as any;

  it('does not claim contribution-after-ads when mapped paid-media facts are absent', () => {
    const result = buildProductAdsPeriod({
      commerceRows: [commerceRow],
      costRows: [costRow],
      mappings: [mapping],
      metaRows: [],
      storeCurrency: 'USD',
    });
    const row = result.products.get(product.id)!;
    expect(row.commerce.contributionBeforeAds).toBe(60);
    expect(row.advertising.sourceRows).toBe(0);
    expect(row.derived.contributionAfterAds).toBeNull();
  });

  it('allows a genuine observed zero-spend period to remain calculable', () => {
    const adRow = {
      ...metricRow({ spend: 0, purchases: 0, purchaseValue: 0 }),
      accountCurrency: 'USD',
      ad: { id: mapping.metaAdId },
    } as any;
    const result = buildProductAdsPeriod({
      commerceRows: [commerceRow],
      costRows: [costRow],
      mappings: [mapping],
      metaRows: [adRow],
      storeCurrency: 'USD',
    });
    const row = result.products.get(product.id)!;
    expect(row.advertising.sourceRows).toBe(1);
    expect(row.advertising.spend).toBe(0);
    expect(row.derived.contributionAfterAds).toBe(60);
  });
});
