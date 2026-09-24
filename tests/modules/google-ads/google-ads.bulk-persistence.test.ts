import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import {
  bulkUpsertGoogleAds,
  GOOGLE_ADS_BULK_BATCH_SIZE,
  type GoogleAdsBulkAdInput,
  type GoogleAdsBulkCreativeInput,
  type GoogleAdsBulkMetricInput,
} from '../../../src/modules/google-ads/google-ads-postgres-bulk-upsert.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;

function ad(index: number, accountId = randomUUID(), campaignId = randomUUID()): GoogleAdsBulkAdInput {
  return {
    id: randomUUID(), accountId, campaignId, groupId: null,
    providerEntityId: `ad-${index}`, name: `Ad ${index}`, status: 'ENABLED',
    effectiveStatus: 'ELIGIBLE', format: 'RESPONSIVE_SEARCH_AD', landingPageUrl: null,
    providerData: { index }, rawJson: { index }, deletedAt: null,
  };
}

function creative(index: number, accountId = randomUUID()): GoogleAdsBulkCreativeInput {
  return {
    id: randomUUID(), accountId, providerEntityId: `asset-${index}`, name: `Asset ${index}`,
    title: `Headline ${index}`, imageUrl: null, videoId: null,
    providerData: { assetType: 'TEXT' }, rawJson: { index }, deletedAt: null,
  };
}

function metric(index: number, accountId = randomUUID()): GoogleAdsBulkMetricInput {
  return {
    id: randomUUID(), metricKey: `GOOGLE_ADS:test:${index}`, accountId,
    campaignId: null, groupId: null, adId: null, level: 'ACCOUNT',
    date: new Date('2026-09-01T00:00:00.000Z'), currency: 'USD', spend: '1.250000',
    impressions: '100', clicks: '10', conversions: '1', conversionValue: '5',
    ctr: '0.1', cpc: '0.125', cpm: '12.5', cpa: '1.25', roas: '4',
    providerMetrics: { attribution: 'GOOGLE_PROVIDER_REPORTED' }, rawJson: { index },
  };
}

describe('Google Ads bounded bulk persistence contract', () => {
  it('scales DB operations with batch count instead of provider row count', async () => {
    const execute = vi.fn(async () => 1);
    const count = GOOGLE_ADS_BULK_BATCH_SIZE * 2 + 1;
    const result = await bulkUpsertGoogleAds(
      { $executeRaw: execute } as never,
      {
        ads: Array.from({ length: count }, (_, index) => ad(index)),
        creatives: Array.from({ length: count }, (_, index) => creative(index)),
        metrics: Array.from({ length: count }, (_, index) => metric(index)),
      },
    );

    expect(execute).toHaveBeenCalledTimes(9);
    expect(result.dbOperations).toBe(9);
    expect(result.dbOperations).toBeLessThan(count / 100);
  });

  it('keeps high-cardinality service paths on the bulk boundary and preserves PMax/tombstoning', () => {
    const source = readFileSync(
      join(process.cwd(), 'src/modules/google-ads/google-ads.service.ts'),
      'utf8',
    );
    expect(source).toContain("kind: 'ASSET_GROUP'");
    expect(source).toContain('bulkUpsertGoogleAds(tx, { ads })');
    expect(source).toContain('bulkUpsertGoogleAds(tx, { creatives })');
    expect(source).toContain('bulkUpsertGoogleAds(tx, { metrics: metricsToWrite })');
    expect(source).not.toContain('advertisingWriteRepository.upsertAd(tx');
    expect(source).not.toContain('advertisingWriteRepository.upsertCreative(tx');
    expect(source).not.toContain('advertisingWriteRepository.upsertDailyMetric(tx');
    expect(source).toContain('tx.advertisingAd.updateMany');
    expect(source).toContain('tx.advertisingCreative.updateMany');
  });
});

describeDatabase('Google Ads bulk persistence integration', () => {
  it('is idempotent and updates ads, assets and metrics without duplicate facts', async () => {
    const store = await prisma.store.create({
      data: {
        shopifyShopId: `gid://shopify/Shop/${randomUUID()}`,
        name: 'Google bulk persistence',
        myshopifyDomain: `google-bulk-${randomUUID()}.myshopify.com`,
        currencyCode: 'USD',
        ianaTimezone: 'UTC',
      },
    });
    try {
      const account = await prisma.advertisingAccount.create({
        data: {
          storeId: store.id, provider: 'GOOGLE_ADS', providerEntityId: '1234567890',
          name: 'Google account', currency: 'USD',
        },
      });
      const campaign = await prisma.advertisingCampaign.create({
        data: {
          accountId: account.id, providerEntityId: 'campaign-1', name: 'Campaign',
        },
      });
      const group = await prisma.advertisingGroup.create({
        data: {
          accountId: account.id, campaignId: campaign.id, providerEntityId: 'group-1',
          kind: 'AD_GROUP', name: 'Group',
        },
      });
      const adInput = ad(1, account.id, campaign.id);
      adInput.groupId = group.id;
      const creativeInput = creative(1, account.id);
      const metricInput = metric(1, account.id);
      metricInput.campaignId = campaign.id;
      metricInput.groupId = group.id;
      metricInput.adId = adInput.id;

      await prisma.$transaction(async (tx) => {
        await bulkUpsertGoogleAds(tx, {
          ads: [adInput], creatives: [creativeInput], metrics: [metricInput],
        });
      });

      adInput.name = 'Updated Ad';
      creativeInput.title = 'Updated headline';
      metricInput.spend = '9.500000';
      await prisma.$transaction(async (tx) => {
        await bulkUpsertGoogleAds(tx, {
          ads: [adInput], creatives: [creativeInput], metrics: [metricInput],
        });
      });

      expect(await prisma.advertisingAd.count({ where: { accountId: account.id } })).toBe(1);
      expect(await prisma.advertisingCreative.count({ where: { accountId: account.id } })).toBe(1);
      expect(await prisma.advertisingDailyMetric.count({ where: { accountId: account.id } })).toBe(1);
      expect((await prisma.advertisingAd.findUnique({ where: { id: adInput.id } }))?.name).toBe(
        'Updated Ad',
      );
      expect(
        (await prisma.advertisingCreative.findUnique({ where: { id: creativeInput.id } }))?.title,
      ).toBe('Updated headline');
      expect(
        Number((await prisma.advertisingDailyMetric.findUnique({ where: { metricKey: metricInput.metricKey } }))?.spend),
      ).toBe(9.5);
    } finally {
      await prisma.store.delete({ where: { id: store.id } });
    }
  });
});
