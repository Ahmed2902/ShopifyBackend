import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { MetaAdsRepository } from '../../../src/modules/meta/ads/meta-ads.repository.js';
import { ShopifyCatalogRepository } from '../../../src/modules/shopify/catalog/shopify-catalog.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const stores: string[] = [];

async function createStore() {
  const suffix = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${suffix}`,
      name: 'Pixel first-materialization store',
      myshopifyDomain: `pixel-first-${suffix}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
    },
  });
  stores.push(store.id);
  return store;
}

async function createOutstandingRepair(
  storeId: string,
  browserSessionId: string,
  input: { metaCampaignExternalId?: string; productExternalId?: string },
) {
  const event = await prisma.storefrontEvent.create({
    data: {
      storeId,
      sessionId: browserSessionId,
      eventId: randomUUID(),
      eventName: input.productExternalId ? 'PRODUCT_VIEW' : 'PAGE_VIEW',
      eventAt: new Date(),
      consentState: 'GRANTED',
      metaCampaignExternalId: input.metaCampaignExternalId ?? null,
      productExternalId: input.productExternalId ?? null,
      retentionExpiresAt: new Date(Date.now() + 86_400_000),
    },
  });
  return prisma.storefrontSessionRepair.create({
    data: {
      storeId,
      browserSessionId,
      sourceReceivedAt: event.receivedAt,
    },
  });
}

afterEach(async () => {
  for (const storeId of stores.splice(0)) {
    await prisma.store.delete({ where: { id: storeId } });
  }
});

describeDatabase('Pixel source invalidation during first materialization', () => {
  it('rotates a raw-only repair generation when Meta hierarchy truth changes', async () => {
    const store = await createStore();
    const connection = await prisma.metaConnection.create({
      data: {
        storeId: store.id,
        accessTokenCiphertext: 'test',
        apiVersion: 'v26.0',
      },
    });
    const account = await prisma.metaAdAccount.create({
      data: {
        storeId: store.id,
        metaConnectionId: connection.id,
        metaAccountId: 'act_100',
        name: 'Account',
        currency: 'USD',
      },
    });
    const browserSessionId = randomUUID();
    const before = await createOutstandingRepair(store.id, browserSessionId, {
      metaCampaignExternalId: '1001',
    });

    await new MetaAdsRepository().upsertCampaign(account.id, { id: '1001', name: 'Campaign' });

    const after = await prisma.storefrontSessionRepair.findUniqueOrThrow({
      where: { storeId_browserSessionId: { storeId: store.id, browserSessionId } },
    });
    expect(after.id).not.toBe(before.id);
    expect(await prisma.storefrontSession.count({ where: { storeId: store.id } })).toBe(0);
  });

  it('rotates a raw-only repair generation when Shopify catalog identity changes', async () => {
    const store = await createStore();
    const browserSessionId = randomUUID();
    const productExternalId = 'gid://shopify/Product/1001';
    const before = await createOutstandingRepair(store.id, browserSessionId, { productExternalId });

    await new ShopifyCatalogRepository().persistProducts(store.id, [
      {
        id: productExternalId,
        title: 'Product',
        status: 'ACTIVE',
        tags: [],
        tracksInventory: false,
      },
    ]);

    const after = await prisma.storefrontSessionRepair.findUniqueOrThrow({
      where: { storeId_browserSessionId: { storeId: store.id, browserSessionId } },
    });
    expect(after.id).not.toBe(before.id);
    expect(await prisma.storefrontSession.count({ where: { storeId: store.id } })).toBe(0);
  });
});
