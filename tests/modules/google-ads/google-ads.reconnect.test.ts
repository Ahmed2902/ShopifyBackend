import { randomUUID } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { GoogleAdsRepository } from '../../../src/modules/google-ads/google-ads.repository.js';
import { GoogleAdsService } from '../../../src/modules/google-ads/google-ads.service.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;

async function createStore(name: string) {
  return prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${randomUUID()}`,
      name,
      myshopifyDomain: `google-reconnect-${randomUUID()}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
    },
  });
}

function connectionInput(storeId: string, suffix: string) {
  return {
    storeId,
    accessTokenCiphertext: `access-${suffix}`,
    accessTokenExpiresAt: new Date(Date.now() + 60_000),
    refreshTokenCiphertext: `refresh-${suffix}`,
    scopes: ['https://www.googleapis.com/auth/adwords'],
    apiVersion: 'v25',
  };
}

function customerInput(storeId: string, connectionId: string, customerId: string) {
  return {
    storeId,
    connectionId,
    customerId,
    loginCustomerId: null,
    descriptiveName: `Customer ${customerId}`,
    status: 'ENABLED',
    currencyCode: 'USD',
    timeZone: 'UTC',
    manager: false,
    testAccount: false,
    level: 0,
    parentCustomerId: null,
    raw: { customer: { id: customerId } },
  };
}

describeDatabase('Google Ads reconnect authorization boundary', () => {
  it('clears prior selection/discovery/checkpoints but preserves and reuses canonical history', async () => {
    const repository = new GoogleAdsRepository();
    const store = await createStore('Google reconnect A');
    try {
      const first = await repository.upsertConnection(connectionInput(store.id, 'identity-a'));
      const customer = await repository.upsertDiscoveredCustomer(
        customerInput(store.id, first.id, '1234567890'),
      );
      await repository.configureCustomers(first.id, ['1234567890']);
      await repository.markSyncCheckpoint({
        connectionId: first.id,
        customerId: '1234567890',
        kind: 'METRICS_AD',
        windowStart: new Date('2026-01-01T00:00:00.000Z'),
        windowEnd: new Date('2026-01-30T00:00:00.000Z'),
      });

      const canonicalBefore = await prisma.advertisingAccount.findUniqueOrThrow({
        where: { id: customer.id },
      });
      expect((await repository.findConnectionForStore(store.id))?.selectedCustomerIds).toEqual([
        '1234567890',
      ]);

      const second = await repository.upsertConnection(connectionInput(store.id, 'identity-b'));
      expect(second.id).toBe(first.id);
      expect((await repository.findConnectionForStore(store.id))?.selectedCustomerIds).toEqual([]);
      expect(await prisma.googleAdsCustomer.count({ where: { storeId: store.id } })).toBe(0);
      expect(
        await prisma.googleAdsSyncCheckpoint.count({
          where: { googleAdsConnectionId: first.id },
        }),
      ).toBe(0);
      expect(await prisma.advertisingAccount.findUnique({ where: { id: canonicalBefore.id } })).not.toBeNull();

      const rediscovered = await repository.upsertDiscoveredCustomer(
        customerInput(store.id, second.id, '1234567890'),
      );
      expect(rediscovered.id).toBe(canonicalBefore.id);
      await repository.configureCustomers(second.id, ['1234567890']);
      expect((await repository.findConnectionForStore(store.id))?.selectedCustomerIds).toEqual([
        '1234567890',
      ]);
    } finally {
      await prisma.googleAdsConnection.deleteMany({ where: { storeId: store.id } });
      await prisma.store.delete({ where: { id: store.id } });
    }
  });

  it('does not reset another store when one store reconnects', async () => {
    const repository = new GoogleAdsRepository();
    const firstStore = await createStore('Google reconnect store one');
    const secondStore = await createStore('Google reconnect store two');
    try {
      const first = await repository.upsertConnection(connectionInput(firstStore.id, 'a'));
      const second = await repository.upsertConnection(connectionInput(secondStore.id, 'b'));
      await repository.upsertDiscoveredCustomer(
        customerInput(firstStore.id, first.id, '1111111111'),
      );
      await repository.upsertDiscoveredCustomer(
        customerInput(secondStore.id, second.id, '2222222222'),
      );
      await repository.configureCustomers(second.id, ['2222222222']);

      await repository.upsertConnection(connectionInput(firstStore.id, 'a2'));

      expect(await prisma.googleAdsCustomer.count({ where: { storeId: firstStore.id } })).toBe(0);
      expect(await prisma.googleAdsCustomer.count({ where: { storeId: secondStore.id } })).toBe(1);
      expect((await repository.findConnectionForStore(secondStore.id))?.selectedCustomerIds).toEqual([
        '2222222222',
      ]);
    } finally {
      await prisma.googleAdsConnection.deleteMany({
        where: { storeId: { in: [firstStore.id, secondStore.id] } },
      });
      await prisma.store.deleteMany({ where: { id: { in: [firstStore.id, secondStore.id] } } });
    }
  });
});

describe('Google Ads current-discovery authorization', () => {
  it('rejects a stale local customer when the current credentials do not rediscover it', async () => {
    let selected: string[] = [];
    const repository = {
      upsertDiscoveredCustomer: vi.fn(),
      pruneDiscoveredCustomers: vi.fn(),
      configureCustomers: vi.fn(async (_connectionId: string, ids: string[]) => {
        selected = ids;
      }),
      findConnectionForStore: vi.fn(async () => ({
        id: 'connection-1',
        status: 'ACTIVE',
        selectedCustomerIds: selected,
        scopes: ['https://www.googleapis.com/auth/adwords'],
        apiVersion: 'v25',
        lastSyncedAt: null,
        lastSyncStatus: null,
        lastSyncError: null,
      })),
      // Deliberately claims stale 123 exists. configureCustomers must not trust this method.
      findSelectedCustomers: vi.fn(async () => [{ customerId: '1234567890', manager: false }]),
    };
    const auth = {
      getApiContext: vi.fn(async () => ({
        connectionId: 'connection-1',
        storeId: 'store-1',
        accessToken: 'current-access-token',
        apiVersion: 'v25',
        scopes: ['https://www.googleapis.com/auth/adwords'],
        selectedCustomerIds: selected,
      })),
    };
    const api = {
      listAccessibleCustomers: vi.fn(async () => ['4564564564']),
      search: vi.fn(async () => [
        {
          customer: {
            id: '4564564564',
            descriptiveName: 'Current customer',
            currencyCode: 'USD',
            timeZone: 'UTC',
            manager: false,
            testAccount: false,
            status: 'ENABLED',
          },
        },
      ]),
    };
    const service = new GoogleAdsService(repository as never, auth as never, api as never);

    await expect(service.configureCustomers('store-1', ['1234567890'])).rejects.toMatchObject({
      code: 'GOOGLE_ADS_CUSTOMER_NOT_ACCESSIBLE',
    });
    expect(repository.findSelectedCustomers).not.toHaveBeenCalled();
    expect(repository.configureCustomers).not.toHaveBeenCalled();
    expect(repository.pruneDiscoveredCustomers).toHaveBeenCalledWith(
      'store-1',
      'connection-1',
      ['4564564564'],
    );

    await expect(service.configureCustomers('store-1', ['4564564564'])).resolves.toMatchObject({
      selectedCustomerIds: ['4564564564'],
    });
  });

  it('preserves manager hierarchy loginCustomerId while authorizing only current client accounts', async () => {
    let selected: string[] = [];
    const persisted: Array<Record<string, unknown>> = [];
    const repository = {
      upsertDiscoveredCustomer: vi.fn(async (input: Record<string, unknown>) => {
        persisted.push({
          ...input,
          loginCustomerId: input.loginCustomerId ?? input.parentCustomerId,
        });
      }),
      pruneDiscoveredCustomers: vi.fn(),
      configureCustomers: vi.fn(async (_connectionId: string, ids: string[]) => {
        selected = ids;
      }),
      findConnectionForStore: vi.fn(async () => ({
        id: 'connection-2', status: 'ACTIVE', selectedCustomerIds: selected,
        scopes: ['https://www.googleapis.com/auth/adwords'], apiVersion: 'v25',
        lastSyncedAt: null, lastSyncStatus: null, lastSyncError: null,
      })),
    };
    const auth = {
      getApiContext: vi.fn(async () => ({
        connectionId: 'connection-2', storeId: 'store-2', accessToken: 'token', apiVersion: 'v25',
        scopes: ['https://www.googleapis.com/auth/adwords'], selectedCustomerIds: selected,
      })),
    };
    const api = {
      listAccessibleCustomers: vi.fn(async () => ['9999999999']),
      search: vi.fn(async (input: { customerId: string }) => {
        if (input.customerId === '9999999999') {
          return [
            {
              customerClient: {
                id: '9999999999', descriptiveName: 'Manager', manager: true, testAccount: false,
                status: 'ENABLED', level: 0,
              },
            },
            {
              customerClient: {
                id: '4564564564', descriptiveName: 'Client', manager: false, testAccount: false,
                status: 'ENABLED', level: 1, currencyCode: 'USD', timeZone: 'UTC',
              },
            },
          ];
        }
        return [{ customer: { id: input.customerId, manager: false, descriptiveName: 'Client' } }];
      }),
    };
    const service = new GoogleAdsService(repository as never, auth as never, api as never);

    await expect(service.configureCustomers('store-2', ['9999999999'])).rejects.toMatchObject({
      code: 'GOOGLE_ADS_MANAGER_NOT_SELECTABLE',
    });
    await service.configureCustomers('store-2', ['4564564564']);

    const client = persisted.find((row) => row.customerId === '4564564564');
    expect(client).toMatchObject({
      customerId: '4564564564',
      loginCustomerId: '9999999999',
      parentCustomerId: '9999999999',
    });
  });
});