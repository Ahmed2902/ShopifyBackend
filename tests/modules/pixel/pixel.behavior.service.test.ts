import { describe, expect, it, vi } from 'vitest';
import type { PixelBehaviorRepository } from '../../../src/modules/pixel/behavior/pixel-behavior.repository.js';
import { PixelBehaviorService } from '../../../src/modules/pixel/behavior/pixel-behavior.service.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const productId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const variantId = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const collectionId = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const orderId = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';

function repositoryMock() {
  return {
    getStoreContext: vi.fn(),
    findDirtyStoreIds: vi.fn().mockResolvedValue([]),
    findDirtySessions: vi.fn().mockResolvedValue([]),
    findSessionsForWindow: vi.fn(),
    findValidOrders: vi.fn(),
    replaceDailyRows: vi.fn().mockResolvedValue({ rows: 0 }),
    acknowledgeWindow: vi.fn().mockResolvedValue(1),
    advanceRollupState: vi.fn().mockResolvedValue({ storeId }),
    recordRollupError: vi.fn(),
    aggregateStore: vi.fn(),
    groupDimension: vi.fn().mockResolvedValue([]),
    groupDimensionKeys: vi.fn().mockResolvedValue([]),
    countDimensionKeys: vi.fn().mockResolvedValue(0),
    findDimensionMetadata: vi.fn().mockResolvedValue([]),
    findProductsForDisplay: vi.fn().mockResolvedValue([]),
    findCollectionsForDisplay: vi.fn().mockResolvedValue([]),
  } as unknown as PixelBehaviorRepository;
}

function session(input: Record<string, unknown> = {}) {
  return {
    id: 'session-db-id',
    startedAt: new Date('2026-09-04T10:00:00.000Z'),
    pageViewCount: 2,
    productViewCount: 1,
    collectionViewCount: 1,
    searchCount: 0,
    addToCartCount: 1,
    removeFromCartCount: 0,
    checkoutStartedAt: new Date('2026-09-04T10:05:00.000Z'),
    checkoutCompletedAt: new Date('2026-09-04T10:10:00.000Z'),
    orderId,
    orderLinkStatus: 'LINKED',
    landingPageUrl: 'https://shop.example/products/shoe',
    products: [
      {
        identityKey: 'variant:shoe',
        shopifyProductExternalId: 'gid://shopify/Product/100',
        shopifyVariantExternalId: 'gid://shopify/ProductVariant/200',
        productId,
        variantId,
        resolutionStatus: 'EXACT',
        viewCount: 1,
        addToCartCount: 1,
        removeFromCartCount: 0,
      },
    ],
    collections: [
      {
        shopifyCollectionExternalId: 'gid://shopify/Collection/300',
        collectionId,
        resolutionStatus: 'EXACT',
        viewCount: 1,
      },
    ],
    ...input,
  };
}

function validOrder() {
  return {
    id: orderId,
    lineItems: [
      {
        productId,
        variantId,
        shopifyProductId: 'gid://shopify/Product/100',
        shopifyVariantId: 'gid://shopify/ProductVariant/200',
      },
    ],
  };
}

describe('PixelBehaviorService', () => {
  it('rolls a product view -> cart -> exact Shopify purchase into privacy-safe daily facts', async () => {
    const repository = repositoryMock();
    vi.mocked(repository.findSessionsForWindow)
      .mockResolvedValueOnce([session()] as never)
      .mockResolvedValueOnce([] as never);
    vi.mocked(repository.findValidOrders).mockResolvedValue([validOrder()] as never);

    const now = new Date('2026-09-05T00:00:00.000Z');
    const service = new PixelBehaviorService(repository, () => now);
    await service.rebuildStoreDate(storeId, 'UTC', '2026-09-04');

    const [, , rows] = vi.mocked(repository.replaceDailyRows).mock.calls[0]!;
    const store = rows.find((row) => row.dimension === 'STORE')!;
    const product = rows.find((row) => row.dimension === 'PRODUCT')!;
    const collection = rows.find((row) => row.dimension === 'COLLECTION')!;
    const landing = rows.find((row) => row.dimension === 'LANDING_PAGE')!;

    expect(store).toMatchObject({
      sessionCount: 1,
      productViewSessionCount: 1,
      addToCartSessionCount: 1,
      checkoutStartSessionCount: 1,
      checkoutCompletedSessionCount: 1,
      linkedPurchaseSessionCount: 1,
      conversionDelayCount: 1,
      conversionDelayMsTotal: 600_000n,
    });
    expect(product).toMatchObject({
      dimensionKey: `product:${productId}`,
      productId,
      sessionCount: 1,
      productViewCount: 1,
      addToCartCount: 1,
      linkedPurchaseSessionCount: 1,
      exactResolutionSessionCount: 1,
      conversionDelayMsTotal: 600_000n,
    });
    expect(collection).toMatchObject({
      collectionId,
      collectionViewCount: 1,
      linkedPurchaseSessionCount: 1,
      exactResolutionSessionCount: 1,
    });
    expect(landing).toMatchObject({
      landingPageUrl: 'https://shop.example/products/shoe',
      linkedPurchaseSessionCount: 1,
    });
    expect(repository.acknowledgeWindow).toHaveBeenCalledWith(
      storeId,
      expect.any(Date),
      expect.any(Date),
      now,
    );
    expect(
      JSON.stringify(rows, (_key, value) => (typeof value === 'bigint' ? value.toString() : value)),
    ).not.toContain('anonymousVisitorId');
  });

  it('redacts arbitrary user-specific landing paths before durable storage', async () => {
    const repository = repositoryMock();
    vi.mocked(repository.findSessionsForWindow)
      .mockResolvedValueOnce([
        session({
          orderId: null,
          orderLinkStatus: 'NONE',
          checkoutCompletedAt: null,
          landingPageUrl: 'https://shop.example/apps/profile/customer@example.com/order-token-123',
          products: [],
          collections: [],
        }),
      ] as never)
      .mockResolvedValueOnce([] as never);
    vi.mocked(repository.findValidOrders).mockResolvedValue([] as never);

    const service = new PixelBehaviorService(repository, () => new Date('2026-09-05T00:00:00.000Z'));
    await service.rebuildStoreDate(storeId, 'UTC', '2026-09-04');

    const rows = vi.mocked(repository.replaceDailyRows).mock.calls[0]?.[2] ?? [];
    const landing = rows.find((row) => row.dimension === 'LANDING_PAGE');
    expect(landing?.landingPageUrl).toBe('https://shop.example/:other');
    expect(JSON.stringify(landing)).not.toContain('customer@example.com');
    expect(JSON.stringify(landing)).not.toContain('order-token-123');
  });

  it('rebuilds both previous and current cohort dates when a late event moves a session', async () => {
    const repository = repositoryMock();
    const dirtyAt = new Date('2026-09-05T01:00:00.000Z');
    vi.mocked(repository.findDirtyStoreIds).mockResolvedValue([storeId]);
    vi.mocked(repository.getStoreContext).mockResolvedValue({
      id: storeId,
      ianaTimezone: 'UTC',
      pixelInstallation: { status: 'ACTIVE', lastEventAt: dirtyAt },
      storefrontBehaviorRollup: null,
    } as never);
    vi.mocked(repository.findDirtySessions).mockResolvedValue([
      {
        id: 'session-db-id',
        startedAt: new Date('2026-09-04T23:30:00.000Z'),
        previousStartedAt: new Date('2026-09-05T00:30:00.000Z'),
        dirtyAt,
      },
    ] as never);
    vi.mocked(repository.findSessionsForWindow).mockResolvedValue([] as never);
    const service = new PixelBehaviorService(repository, () => dirtyAt);
    const rebuild = vi.spyOn(service, 'rebuildStoreDate').mockResolvedValue({ date: '', rows: 0 });

    await service.rollupDirtyStores();

    expect(rebuild.mock.calls.map((call) => call[2])).toEqual(['2026-09-04', '2026-09-05']);
  });

  it('returns current/comparison first-party funnel rates using store-timezone windows', async () => {
    const repository = repositoryMock();
    vi.mocked(repository.getStoreContext).mockResolvedValue({
      id: storeId,
      ianaTimezone: 'UTC',
      pixelInstallation: { status: 'ACTIVE', lastEventAt: new Date('2026-09-04T20:00:00.000Z') },
      storefrontBehaviorRollup: {
        rolledThroughMaterializedAt: new Date('2026-09-04T20:00:01.000Z'),
        lastRolledUpAt: new Date('2026-09-04T20:00:02.000Z'),
        lastError: null,
      },
    } as never);
    vi.mocked(repository.aggregateStore)
      .mockResolvedValueOnce({
        _sum: {
          sessionCount: 100,
          productViewSessionCount: 60,
          addToCartSessionCount: 20,
          checkoutStartSessionCount: 10,
          checkoutCompletedSessionCount: 8,
          linkedPurchaseSessionCount: 5,
          conversionDelayCount: 5,
          conversionDelayMsTotal: 3_000_000n,
        },
      } as never)
      .mockResolvedValueOnce({
        _sum: {
          sessionCount: 80,
          productViewSessionCount: 40,
          addToCartSessionCount: 10,
          checkoutStartSessionCount: 8,
          checkoutCompletedSessionCount: 6,
          linkedPurchaseSessionCount: 4,
          conversionDelayCount: 4,
          conversionDelayMsTotal: 2_000_000n,
        },
      } as never);

    const service = new PixelBehaviorService(repository, () => new Date('2026-09-05T12:00:00.000Z'));
    const result = await service.overview(storeId, { days: 1 });

    expect(result.window.current.fromDate).toBe('2026-09-04');
    expect(result.window.comparison.fromDate).toBe('2026-09-03');
    expect(result.current).toMatchObject({
      sessions: 100,
      productViewRate: 0.6,
      addToCartRate: 0.2,
      viewToCartRate: 1 / 3,
      linkedPurchaseRate: 0.05,
      cartToPurchaseRate: 0.25,
      checkoutToPurchaseRate: 0.5,
      averageSessionToPurchaseMs: 600_000,
    });
    expect(result.comparison.linkedPurchaseRate).toBe(0.05);
    expect(result.dataQuality.state).toBe('READY');
    expect(result.methodology.interpretation).toContain('no causal attribution');
  });
});
