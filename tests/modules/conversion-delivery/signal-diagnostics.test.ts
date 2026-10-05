import { beforeEach, describe, expect, it, vi } from 'vitest';
import { conversionSignalHealth } from '../../../src/modules/conversion-delivery/signal-diagnostics.js';
const mocks = vi.hoisted(() => ({
  destinations: vi.fn(),
  facts: vi.fn(),
  store: vi.fn(),
  orders: vi.fn(),
}));
vi.mock('../../../src/lib/prisma.js', () => ({
  prisma: {
    conversionDestination: { findMany: mocks.destinations },
    $queryRaw: mocks.facts,
    store: { findUnique: mocks.store },
    order: { count: mocks.orders },
  },
}));
describe('factual signal health by credential source', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.destinations.mockResolvedValue([
      { id: 'destination-a', provider: 'META', status: 'ACTIVE', configJson: {} },
    ]);
    mocks.facts.mockResolvedValue([]);
    mocks.store.mockResolvedValue(null);
    mocks.orders.mockResolvedValue(0);
  });
  it('does not report missing OAuth scope or OAuth expiry for a standalone Events Manager token', async () => {
    mocks.store.mockResolvedValue({
      metaConnection: { status: 'ACTIVE', scopes: [], tokenExpiresAt: new Date(0) },
    });
    const health = await conversionSignalHealth('store-a');
    const meta = health.providers.find((p) => p.provider === 'META')!;
    expect(meta.connection).toMatchObject({
      credentialSource: 'EVENTS_MANAGER_DESTINATION',
      tokenExpired: false,
    });
    expect(meta.connection).not.toHaveProperty('permissionAvailable');
  });
  it('reports actual scope and expiry requirements for managed Meta destinations', async () => {
    mocks.destinations.mockResolvedValue([
      {
        id: 'destination-a',
        provider: 'META',
        status: 'ACTIVE',
        configJson: { authSource: 'META_CONNECTION' },
      },
    ]);
    mocks.store.mockResolvedValue({
      metaConnection: { status: 'ACTIVE', scopes: ['ads_read'], tokenExpiresAt: new Date(0) },
    });
    const meta = (await conversionSignalHealth('store-a')).providers.find(
      (p) => p.provider === 'META',
    )!;
    expect(meta.connection).toMatchObject({
      credentialSource: 'META_CONNECTION',
      permissionAvailable: false,
      tokenExpired: true,
    });
  });
  it('scopes reads to the merchant and returns counts without protected matching values', async () => {
    await conversionSignalHealth('store-a');
    expect(mocks.destinations.mock.calls[0]![0].where).toEqual({ storeId: 'store-a' });
    expect(mocks.store.mock.calls[0]![0].where).toEqual({ id: 'store-a' });
    expect(mocks.orders.mock.calls[0]![0].where.storeId).toBe('store-a');
    expect(mocks.facts.mock.calls[0]![0].values).toContain('store-a');
    const select = mocks.destinations.mock.calls[0]![0].select;
    expect(select).not.toHaveProperty('accessTokenCiphertext');
  });
  it('exposes per-stage and item denominators without inventing provider match rates', async () => {
    mocks.facts.mockResolvedValueOnce([
      {
        provider: 'META',
        eventName: 'PRODUCT_VIEW',
        status: 'DELIVERED',
        total: 2n,
        measured: 2n,
        clickId: 1n,
        browserId: 2n,
        email: 0n,
        phone: 0n,
        externalId: 0n,
        userAgent: 2n,
        ip: 0n,
        lastDelivery: null,
        reasonCode: null,
        browserReasonCode: null,
        contentMeasured: 2n,
        observedContentItems: 3n,
        mappedContentItems: 2n,
        ambiguousContentItems: 1n,
        browserDispatched: 1n,
      },
    ]);
    mocks.facts.mockResolvedValueOnce([
      {
        provider: 'META',
        eventName: 'PRODUCT_VIEW',
        collected: 10n,
        consented: 8n,
        withinDispatchWindow: 7n,
        queued: 2n,
        matchingMeasured: 2n,
        acknowledged: 2n,
        browserReported: 1n,
      },
    ]);
    const meta = (await conversionSignalHealth('store-a')).providers[0]!;
    expect(meta.facts[0]!.content).toEqual({
      measured: 2,
      observedItems: 3,
      mappedItems: 2,
      ambiguousItems: 1,
    });
    expect(meta.funnel[0]).toMatchObject({
      collected: 10,
      consented: 8,
      queued: 2,
      acknowledged: 2,
    });
    expect(meta.facts[0]!.coverage.denominator).toBe(2);
    expect(meta).not.toHaveProperty('eventMatchQuality');
  });
});
