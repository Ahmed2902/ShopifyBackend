import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { MetaCollectionMappingRepository } from '../../../src/modules/meta/mapping/meta-collection-mapping.repository.js';
import { MetaMappingRepository } from '../../../src/modules/meta/mapping/meta-mapping.repository.js';
import type { AdResolution } from '../../../src/modules/meta/mapping/meta-mapping.types.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const createdStoreIds: string[] = [];

async function createFixture() {
  const suffix = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${suffix}`,
      name: 'Mapping Test Store',
      myshopifyDomain: `mapping-${suffix}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
    },
  });
  createdStoreIds.push(store.id);

  const connection = await prisma.metaConnection.create({
    data: {
      storeId: store.id,
      accessTokenCiphertext: 'test-ciphertext',
      apiVersion: 'v26.0',
      selectedAdAccountIds: ['act_mapping_test'],
    },
  });
  const account = await prisma.metaAdAccount.create({
    data: {
      storeId: store.id,
      metaConnectionId: connection.id,
      metaAccountId: 'act_mapping_test',
      name: 'Mapping Test Account',
      currency: 'USD',
    },
  });
  const campaign = await prisma.metaCampaign.create({
    data: {
      adAccountId: account.id,
      metaCampaignId: 'campaign_mapping_test',
      name: 'Mapping Test Campaign',
    },
  });
  const adSet = await prisma.metaAdSet.create({
    data: {
      adAccountId: account.id,
      campaignId: campaign.id,
      metaAdSetId: 'adset_mapping_test',
      name: 'Mapping Test Ad Set',
    },
  });
  const ad = await prisma.metaAd.create({
    data: {
      adAccountId: account.id,
      campaignId: campaign.id,
      adSetId: adSet.id,
      metaAdId: 'ad_mapping_test',
      name: 'Mapping Test Ad',
    },
  });
  const product = await prisma.product.create({
    data: {
      storeId: store.id,
      shopifyProductId: `gid://shopify/Product/${suffix}`,
      title: 'Classic Hoodie',
      status: 'ACTIVE',
    },
  });
  const variant = await prisma.productVariant.create({
    data: {
      storeId: store.id,
      productId: product.id,
      shopifyVariantId: `gid://shopify/ProductVariant/${suffix}`,
      title: 'Black / M',
    },
  });

  return { store, ad, product, variant };
}

async function cleanupStore(storeId: string) {
  const accounts = await prisma.metaAdAccount.findMany({
    where: { storeId },
    select: { id: true },
  });
  const accountIds = accounts.map((account) => account.id);
  const ads = await prisma.metaAd.findMany({
    where: { adAccountId: { in: accountIds } },
    select: { id: true },
  });
  const adIds = ads.map((ad) => ad.id);
  const products = await prisma.product.findMany({
    where: { storeId },
    select: { id: true },
  });
  const productIds = products.map((product) => product.id);
  const variants = await prisma.productVariant.findMany({
    where: { storeId },
    select: { id: true },
  });
  const variantIds = variants.map((variant) => variant.id);

  await prisma.$transaction([
    prisma.adProductMapping.deleteMany({ where: { metaAdId: { in: adIds } } }),
    prisma.adCollectionMapping.deleteMany({ where: { metaAdId: { in: adIds } } }),
    prisma.catalogItemVariantMapping.deleteMany({ where: { variantId: { in: variantIds } } }),
    prisma.metaInsightAction.deleteMany({
      where: { insight: { adAccountId: { in: accountIds } } },
    }),
    prisma.metaInsightDaily.deleteMany({ where: { adAccountId: { in: accountIds } } }),
    prisma.metaAd.deleteMany({ where: { adAccountId: { in: accountIds } } }),
    prisma.metaCreative.deleteMany({ where: { adAccountId: { in: accountIds } } }),
    prisma.metaAdSet.deleteMany({ where: { adAccountId: { in: accountIds } } }),
    prisma.metaCampaign.deleteMany({ where: { adAccountId: { in: accountIds } } }),
    prisma.metaAdAccount.deleteMany({ where: { id: { in: accountIds } } }),
    prisma.metaCatalogItem.deleteMany({ where: { catalog: { storeId } } }),
    prisma.metaProductCatalog.deleteMany({ where: { storeId } }),
    prisma.metaConnection.deleteMany({ where: { storeId } }),
    prisma.variantOption.deleteMany({ where: { variantId: { in: variantIds } } }),
    prisma.inventoryItem.deleteMany({ where: { storeId } }),
    prisma.productVariant.deleteMany({ where: { id: { in: variantIds } } }),
    prisma.product.deleteMany({ where: { id: { in: productIds } } }),
    prisma.store.delete({ where: { id: storeId } }),
  ]);
}

afterEach(async () => {
  for (const storeId of createdStoreIds.splice(0)) {
    await cleanupStore(storeId);
  }
});

describeDatabase('MetaMappingRepository', () => {
  it('is idempotent for the same automatic mapping and does not create history noise', async () => {
    const fixture = await createFixture();
    const repository = new MetaMappingRepository();
    const resolution: AdResolution = {
      scope: 'VARIANT',
      confidence: 1,
      mappings: [
        {
          productId: fixture.product.id,
          variantId: fixture.variant.id,
          catalogItemId: null,
          granularity: 'VARIANT',
          optionSelector: null,
          source: 'URL',
          confidence: 1,
          landingUrl: 'https://store.test/products/classic-hoodie?variant=1',
          providerProductId: null,
          providerProductGroupId: null,
          evidence: { matchedBy: 'destination_variant_url' },
        },
      ],
      evidence: { matchedBy: 'destination_variant_url' },
      suggestions: [],
    };

    await expect(repository.applyAutomaticAdResolution(fixture.ad.id, resolution)).resolves.toMatchObject({
      changed: true,
      scope: 'VARIANT',
    });
    await expect(repository.applyAutomaticAdResolution(fixture.ad.id, resolution)).resolves.toMatchObject({
      changed: false,
      scope: 'VARIANT',
    });

    const rows = await prisma.adProductMapping.findMany({ where: { metaAdId: fixture.ad.id } });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      productId: fixture.product.id,
      variantId: fixture.variant.id,
      source: 'URL',
      validUntil: null,
      isMerchantConfirmed: false,
    });
  });

  it('preserves merchant-confirmed mappings when later automatic evidence disagrees', async () => {
    const fixture = await createFixture();
    const repository = new MetaMappingRepository();

    await repository.replaceManualAdMappings(fixture.store.id, fixture.ad.metaAdId, [
      {
        productId: fixture.product.id,
        variantId: fixture.variant.id,
        granularity: 'VARIANT',
        optionSelector: null,
      },
    ]);

    const automatic: AdResolution = {
      scope: 'UNKNOWN',
      confidence: 0,
      mappings: [],
      evidence: { reason: 'no_deterministic_ad_match' },
      suggestions: [],
    };
    const result = await repository.applyAutomaticAdResolution(fixture.ad.id, automatic);

    expect(result).toMatchObject({ state: 'PRESERVED_CONFIRMED', scope: 'VARIANT' });
    const active = await prisma.adProductMapping.findMany({
      where: { metaAdId: fixture.ad.id, validUntil: null },
    });
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      productId: fixture.product.id,
      variantId: fixture.variant.id,
      source: 'MANUAL',
      isMerchantConfirmed: true,
    });
    const ad = await prisma.metaAd.findUnique({ where: { id: fixture.ad.id } });
    expect(ad).toMatchObject({ targetScope: 'VARIANT' });
    expect(Number(ad?.targetScopeConfidence)).toBe(1);
  });

  it('releases merchant-confirmed variant precedence after the Shopify variant is deleted', async () => {
    const fixture = await createFixture();
    const repository = new MetaCollectionMappingRepository();

    await repository.replaceManualProductMappings(fixture.store.id, fixture.ad.metaAdId, [
      {
        productId: fixture.product.id,
        variantId: fixture.variant.id,
        granularity: 'VARIANT',
      },
    ]);
    await prisma.productVariant.update({
      where: { id: fixture.variant.id },
      data: { deletedAt: new Date('2026-09-04T11:20:00.000Z') },
    });

    const automatic: AdResolution = {
      scope: 'UNKNOWN',
      confidence: 0,
      mappings: [],
      evidence: { reason: 'no_current_deterministic_target' },
      suggestions: [],
    };
    const result = await repository.applyAutomaticAdResolution({
      adId: fixture.ad.id,
      resolution: automatic,
      collection: null,
      landingUrl: null,
    });

    expect(result).toMatchObject({ state: 'UNKNOWN', scope: 'UNKNOWN', changed: true });
    await expect(
      prisma.adProductMapping.findMany({
        where: { metaAdId: fixture.ad.id, validUntil: null },
      }),
    ).resolves.toEqual([]);
    const ad = await prisma.metaAd.findUnique({ where: { id: fixture.ad.id } });
    expect(ad).toMatchObject({ targetScope: 'UNKNOWN' });
  });
});
