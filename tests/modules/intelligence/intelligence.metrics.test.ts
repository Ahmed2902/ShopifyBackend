import { describe, expect, it } from 'vitest';
import {
  buildCampaignEvidence,
  buildProductEvidence,
} from '../../../src/modules/intelligence/intelligence.metrics.js';

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

  it('time-matches product cost using processedAt with Shopify-created fallback', () => {
    const variantId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
    const result = buildProductEvidence({
      commerceRows: [
        {
          productId,
          variantId,
          quantity: 1,
          discountedTotal: 100,
          order: {
            shopifyCreatedAt: new Date('2026-08-31T23:30:00.000Z'),
            processedAt: new Date('2026-09-01T00:30:00.000Z'),
            currencyCode: 'USD',
          },
          product: {
            id: productId,
            shopifyProductId: 'gid://shopify/Product/1',
            title: 'Core Product',
          },
          refundLines: [],
        },
      ] as unknown as Parameters<typeof buildProductEvidence>[0]['commerceRows'],
      costRows: [
        {
          variantId,
          amount: 10,
          currency: 'USD',
          effectiveFrom: new Date('2026-08-01T00:00:00.000Z'),
          effectiveUntil: new Date('2026-09-01T00:00:00.000Z'),
        },
        {
          variantId,
          amount: 20,
          currency: 'USD',
          effectiveFrom: new Date('2026-09-01T00:00:00.000Z'),
          effectiveUntil: null,
        },
      ] as unknown as Parameters<typeof buildProductEvidence>[0]['costRows'],
      inventoryRows: [],
      mappings: [],
      metaRows: [],
      storeCurrency: 'USD',
      inventoryTrusted: false,
      windowDays: 28,
    });

    expect(result.products[0]).toMatchObject({
      costCoverage: 1,
      contributionBeforeAds: 80,
      contributionAfterAds: 80,
    });
  });
});

describe('Meta intelligence evidence', () => {
  it('suppresses period reach because ad-level daily reach is non-additive', () => {
    const campaignId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
    const rows = [
      {
        date: new Date('2026-09-01T00:00:00.000Z'),
        syncedAt: new Date('2026-09-02T00:00:00.000Z'),
        accountCurrency: 'USD',
        spend: 50,
        impressions: 1_000n,
        clicks: 50n,
        frequency: 1.2,
        campaign: { id: campaignId, metaCampaignId: 'meta-campaign-1', name: 'Campaign' },
        ad: null,
        actions: [],
      },
      {
        date: new Date('2026-09-02T00:00:00.000Z'),
        syncedAt: new Date('2026-09-03T00:00:00.000Z'),
        accountCurrency: 'USD',
        spend: 60,
        impressions: 1_100n,
        clicks: 55n,
        frequency: 1.3,
        campaign: { id: campaignId, metaCampaignId: 'meta-campaign-1', name: 'Campaign' },
        ad: null,
        actions: [],
      },
    ] as unknown as Parameters<typeof buildCampaignEvidence>[0];

    const result = buildCampaignEvidence(
      rows,
      new Date('2026-09-01T00:00:00.000Z'),
      new Date('2026-09-02T00:00:00.000Z'),
      new Date('2026-08-30T00:00:00.000Z'),
      new Date('2026-08-31T00:00:00.000Z'),
    );

    expect(result[0]?.current.reach).toBeNull();
    expect(result[0]?.current.impressions).toBe(2_100);
  });

  it('uses the prioritized purchase family for ROAS fallback instead of the numerically largest family', () => {
    const campaignId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
    const rows = [
      {
        date: new Date('2026-09-01T00:00:00.000Z'),
        syncedAt: new Date('2026-09-02T00:00:00.000Z'),
        accountCurrency: 'USD',
        spend: 100,
        impressions: 1_000n,
        clicks: 50n,
        frequency: 1.1,
        campaign: { id: campaignId, metaCampaignId: 'meta-campaign-roas', name: 'ROAS Campaign' },
        ad: null,
        actions: [
          {
            kind: 'WEBSITE_PURCHASE_ROAS',
            actionType: 'offsite_conversion.fb_pixel_purchase',
            actionDestination: null,
            value: 2,
          },
          {
            kind: 'WEBSITE_PURCHASE_ROAS',
            actionType: 'purchase',
            actionDestination: null,
            value: 9,
          },
        ],
      },
    ] as unknown as Parameters<typeof buildCampaignEvidence>[0];

    const result = buildCampaignEvidence(
      rows,
      new Date('2026-09-01T00:00:00.000Z'),
      new Date('2026-09-01T23:59:59.999Z'),
      new Date('2026-08-31T00:00:00.000Z'),
      new Date('2026-08-31T23:59:59.999Z'),
    );

    expect(result[0]?.current.purchaseValue).toBe(200);
    expect(result[0]?.current.roas).toBe(2);
  });
});
