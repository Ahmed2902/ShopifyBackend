import { describe, expect, it } from 'vitest';
import { buildProductEvidence } from '../../../src/modules/intelligence/intelligence.metrics.js';

const productId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const adId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

describe('Product intelligence evidence', () => {
  it('keeps an exactly mapped paid product even when Shopify has zero sales', () => {
    const result = buildProductEvidence({
      commerceRows: [],
      costRows: [],
      inventoryRows: [],
      mappings: [
        {
          metaAdId: adId,
          productId,
          variantId: null,
          confidence: 0.9,
          source: 'URL',
          isMerchantConfirmed: false,
          product: {
            id: productId,
            shopifyProductId: 'gid://shopify/Product/1',
            title: 'Paid Only Product',
          },
        },
      ] as unknown as Parameters<typeof buildProductEvidence>[0]['mappings'],
      metaRows: [
        {
          date: new Date('2026-09-01T00:00:00.000Z'),
          syncedAt: new Date('2026-09-02T00:00:00.000Z'),
          accountCurrency: 'USD',
          spend: 100,
          impressions: 2_000n,
          reach: 1_500n,
          clicks: 100n,
          frequency: 1.2,
          campaign: null,
          ad: {
            id: adId,
            metaAdId: 'meta-ad-1',
            name: 'Ad 1',
            creative: null,
          },
          actions: [],
        },
      ] as unknown as Parameters<typeof buildProductEvidence>[0]['metaRows'],
      storeCurrency: 'USD',
      inventoryTrusted: false,
      windowDays: 28,
    });

    expect(result.products).toHaveLength(1);
    expect(result.products[0]).toMatchObject({
      entityId: productId,
      name: 'Paid Only Product',
      units: 0,
      netRevenue: 0,
      mappedMetaSpend: 100,
      mappedImpressions: 2_000,
      mappedSpendShare: 1,
      mappingConfidence: 0.9,
      mappingCoverage: 1,
    });
  });
});
