import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { disconnectAdvertisingProvider } from '../../../src/modules/integrations/provider-disconnect.service.js';
import { ConversionDeliveryRepository } from '../../../src/modules/conversion-delivery/conversion-delivery.repository.js';
import { MetaRepository } from '../../../src/modules/meta/meta.repository.js';
import { TikTokRepository } from '../../../src/modules/tiktok/tiktok.repository.js';
import { PixelRepository } from '../../../src/modules/pixel/pixel.repository.js';
vi.mock('../../../src/lib/store-decision-cache.js', () => ({
  invalidateStoreDecisionCaches: vi.fn(),
}));
const database = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const stores: string[] = [];
async function fixture() {
  const key = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: key,
      name: 'Disconnect test',
      myshopifyDomain: `disconnect-${key}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
    },
  });
  stores.push(store.id);
  await prisma.metaConnection.create({
    data: {
      storeId: store.id,
      accessTokenCiphertext: 'meta-credential',
      selectedAdAccountIds: ['account-a'],
      selectedCatalogIds: ['catalog-a'],
      scopes: ['ads_read'],
      apiVersion: 'v26.0',
    },
  });
  await prisma.tikTokConnection.create({
    data: {
      storeId: store.id,
      accessTokenCiphertext: 'tiktok-credential',
      refreshTokenCiphertext: 'refresh-credential',
      selectedAdvertiserIds: ['advertiser-a'],
      selectedCatalogIds: ['catalog-b'],
      scopes: ['65'],
      apiVersion: 'v1.3',
    },
  });
  const now = new Date(Date.now() + 86400_000);
  await prisma.storeSubscription.create({
    data: {
      storeId: store.id,
      selectedPlan: 'PRO',
      provider: 'INTERNAL',
      status: 'TRIALING',
      trialStartedAt: now,
      trialEndsAt: new Date(now.getTime() + 86400_000),
    },
  });
  for (const provider of ['META', 'TIKTOK'] as const) {
    const destination = await prisma.conversionDestination.create({
      data: {
        storeId: store.id,
        provider,
        externalId: `${key}-${provider}`,
        accessTokenCiphertext: 'manual-credential',
        status: 'ACTIVE',
      },
    });
    await prisma.conversionDelivery.create({
      data: {
        storeId: store.id,
        destinationId: destination.id,
        provider,
        sourceOrderId: randomUUID(),
        eventKey: key + provider,
        shopifyOrderId: key,
        eventName: 'PURCHASE',
        eventAt: now,
        value: '10',
        currencyCode: 'USD',
        nextAttemptAt: now,
      },
    });
  }
  return store;
}
afterEach(async () => {
  for (const id of stores.splice(0)) {
    await prisma.conversionDelivery.deleteMany({ where: { storeId: id } });
    await prisma.conversionDestination.deleteMany({ where: { storeId: id } });
    await prisma.metaConnection.deleteMany({ where: { storeId: id } });
    await prisma.tikTokConnection.deleteMany({ where: { storeId: id } });
    await prisma.pixelInstallation.deleteMany({ where: { storeId: id } });
    await prisma.storeSubscription.deleteMany({ where: { storeId: id } });
    await prisma.store.delete({ where: { id } });
  }
});
database('Disconnect persistence and dispatch guards', () => {
  it.each(['META', 'TIKTOK'] as const)(
    'disconnects %s idempotently without changing another store or channel; excludes pending sends',
    async (provider) => {
      const own = await fixture();
      const other = await fixture();
      await disconnectAdvertisingProvider(own.id, provider);
      await disconnectAdvertisingProvider(own.id, provider);
      const connection =
        provider === 'META'
          ? await prisma.metaConnection.findUniqueOrThrow({ where: { storeId: own.id } })
          : await prisma.tikTokConnection.findUniqueOrThrow({ where: { storeId: own.id } });
      // A late failure from a request started before disconnect cannot revive the login.
      if (provider === 'META')
        await new MetaRepository().markConnectionReauthRequired(connection.id);
      else await new TikTokRepository().markConnectionReauthRequired(connection.id);
      const current =
        provider === 'META'
          ? await prisma.metaConnection.findUniqueOrThrow({ where: { storeId: own.id } })
          : await prisma.tikTokConnection.findUniqueOrThrow({ where: { storeId: own.id } });
      expect(current.status).toBe('DISCONNECTED');
      expect(connection.status).toBe('DISCONNECTED');
      expect(connection.accessTokenCiphertext).toBe('');
      const destinations = await prisma.conversionDestination.findMany({
        where: { storeId: { in: [own.id, other.id] } },
      });
      expect(
        destinations.find((row) => row.storeId === own.id && row.provider === provider),
      ).toMatchObject({ status: 'DISABLED', accessTokenCiphertext: null });
      expect(
        destinations
          .filter((row) => row.storeId !== own.id || row.provider !== provider)
          .every(
            (row) => row.status === 'ACTIVE' && row.accessTokenCiphertext === 'manual-credential',
          ),
      ).toBe(true);
      expect(await prisma.conversionDelivery.count({ where: { storeId: own.id } })).toBe(2);
      const claims = await new ConversionDeliveryRepository().claimDue(
        100,
        new Date(Date.now() + 86400_001),
      );
      expect(
        claims.filter((row) => row.storeId === own.id).map((row) => row.provider),
      ).not.toContain(provider);
      expect(claims.some((row) => row.storeId === own.id && row.provider !== provider)).toBe(true);
    },
  );
  it('invalidates an in-flight pixel install and blocks a replacement until removal finishes', async () => {
    const own = await fixture();
    const repository = new PixelRepository();
    const installation = await prisma.pixelInstallation.create({
      data: {
        storeId: own.id,
        status: 'PROVISIONING',
        collectorTokenHash: 'a'.repeat(64),
        collectorTokenPrefix: 'abcdefgh',
        pendingCollectorTokenHash: 'b'.repeat(64),
        pendingCollectorTokenPrefix: 'ijklmnop',
      },
    });
    const operationHash = 'c'.repeat(64);
    await repository.beginDisconnect(own.id, operationHash);
    expect(
      await repository.finalizeInstallation({
        id: installation.id,
        expectedPendingTokenHash: 'b'.repeat(64),
        shopifyWebPixelId: 'gid://shopify/WebPixel/1',
        installedAt: new Date(),
      }),
    ).toBeNull();
    expect(
      await repository.stageInstallation({
        id: randomUUID(),
        storeId: own.id,
        collectorTokenHash: 'd'.repeat(64),
        collectorTokenPrefix: 'qrstuvwx',
        status: 'PROVISIONING',
      }),
    ).toBeNull();
    await repository.finishDisconnect(own.id, operationHash, true);
    expect(await repository.findInstallationForIngress(installation.id)).toMatchObject({
      status: 'DISABLED',
      pendingCollectorTokenHash: null,
    });
    expect(
      await repository.stageInstallation({
        id: randomUUID(),
        storeId: own.id,
        collectorTokenHash: 'd'.repeat(64),
        collectorTokenPrefix: 'qrstuvwx',
        status: 'PROVISIONING',
      }),
    ).not.toBeNull();
  });
});
