import { describe, expect, it, vi } from 'vitest';
import type { PixelBehaviorRepository } from '../../../src/modules/pixel/behavior/pixel-behavior.repository.js';
import { PixelBehaviorService } from '../../../src/modules/pixel/behavior/pixel-behavior.service.js';
import type { PixelJourneyRepository } from '../../../src/modules/pixel/journey/pixel-journey.repository.js';
import { PixelJourneyService } from '../../../src/modules/pixel/journey/pixel-journey.service.js';
import { storefrontEventSchema } from '../../../src/modules/pixel/pixel.schema.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const browserSessionId = 'session_cart_view_001';
const retention = new Date('2026-12-03T12:00:00.000Z');
const now = new Date('2026-09-05T00:00:00.000Z');

function journeyRepository() {
  const cartEvent = {
    id: 'event-db-id',
    eventId: 'event_cart_view_0001',
    eventName: 'CART_VIEW',
    eventAt: new Date('2026-09-04T10:00:00.000Z'),
    receivedAt: new Date('2026-09-04T10:00:01.000Z'),
    anonymousVisitorId: 'visitor_cart_001',
    pageUrl: 'https://shop.example/cart',
    referrerUrl: null,
    landingPageUrl: 'https://shop.example/',
    productExternalId: null,
    variantExternalId: null,
    collectionExternalId: null,
    quantity: null,
    shopifyCheckoutToken: null,
    shopifyOrderExternalId: null,
    utmSource: null,
    utmMedium: null,
    utmCampaign: null,
    utmContent: null,
    utmTerm: null,
    metaClickId: null,
    googleClickId: null,
    tiktokClickId: null,
    metaCampaignExternalId: null,
    metaAdSetExternalId: null,
    metaAdExternalId: null,
    retentionExpiresAt: retention,
  };

  return {
    findSessionRepairMarker: vi.fn().mockResolvedValue({ id: 'repair-marker-id' }),
    findSessionEvents: vi.fn().mockResolvedValue([cartEvent]),
    resolveMetaHierarchy: vi.fn().mockResolvedValue({ campaigns: [], adSets: [], ads: [] }),
    resolveCommerceEntities: vi.fn().mockResolvedValue({ products: [], variants: [], collections: [] }),
    findOrderByExternalId: vi.fn().mockResolvedValue(null),
    replaceSessionReadModel: vi.fn().mockResolvedValue({ id: 'session-db-id' }),
    clearSessionRepair: vi.fn().mockResolvedValue({ count: 1 }),
    findDirtySessionKeys: vi.fn().mockResolvedValue([]),
    findPendingOrderSessions: vi.fn().mockResolvedValue([]),
    setOrderLink: vi.fn().mockResolvedValue({ count: 1 }),
    scheduleOrderLinkRetry: vi.fn().mockResolvedValue({ count: 1 }),
    deleteExpiredSessions: vi.fn().mockResolvedValue({ selected: 0, deleted: 0 }),
    listSessions: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    getSession: vi.fn().mockResolvedValue(null),
    getSessionTimeline: vi.fn().mockResolvedValue([]),
    listVisitorSessions: vi.fn().mockResolvedValue([]),
    findDisplayEntities: vi.fn().mockResolvedValue([[], [], [], [], []]),
  } as unknown as PixelJourneyRepository;
}

function behaviorRepository() {
  return {
    getStoreContext: vi.fn(),
    findDirtyStoreIds: vi.fn().mockResolvedValue([]),
    withStoreRollupLock: vi.fn(async (_storeId: string, work: () => Promise<unknown>) => work()),
    findDirtySessions: vi.fn().mockResolvedValue([]),
    findSessionsForWindow: vi.fn(),
    findValidOrders: vi.fn().mockResolvedValue([]),
    replaceDailyRows: vi.fn().mockResolvedValue({ rows: 0 }),
    acknowledgeSessions: vi.fn().mockResolvedValue(1),
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

describe('cart-view funnel', () => {
  it('accepts CART_VIEW as a first-class store/session event without requiring a product target', () => {
    const parsed = storefrontEventSchema.parse({
      eventId: 'event_cart_view_0001',
      eventName: 'CART_VIEW',
      eventAt: '2026-09-04T10:00:00.000Z',
      consentState: 'GRANTED',
      pageUrl: 'https://shop.example/cart',
    });

    expect(parsed.eventName).toBe('CART_VIEW');
    expect(parsed.productExternalId).toBeUndefined();
    expect(parsed.variantExternalId).toBeUndefined();
  });

  it('materializes CART_VIEW into the session funnel without fabricating product interactions', async () => {
    const repository = journeyRepository();
    const service = new PixelJourneyService(repository, () => now);

    await service.materializeSession(storeId, browserSessionId);

    const [, , , aggregate, , products] = vi.mocked(repository.replaceSessionReadModel).mock.calls[0]!;
    expect(aggregate).toMatchObject({
      eventCount: 1,
      cartViewCount: 1,
      productViewCount: 0,
      addToCartCount: 0,
      removeFromCartCount: 0,
    });
    expect(products).toEqual([]);
  });

  it('persists cart-view funnel intersections instead of counting unrelated checkout sessions', async () => {
    const repository = behaviorRepository();
    const cartSession = {
      id: 'session-cart',
      startedAt: new Date('2026-09-04T10:00:00.000Z'),
      pageViewCount: 2,
      productViewCount: 0,
      collectionViewCount: 0,
      searchCount: 0,
      addToCartCount: 0,
      removeFromCartCount: 0,
      cartViewCount: 2,
      checkoutStartedAt: new Date('2026-09-04T10:05:00.000Z'),
      checkoutCompletedAt: new Date('2026-09-04T10:10:00.000Z'),
      orderId: 'order-cart',
      orderLinkStatus: 'LINKED',
      landingPageUrl: 'https://shop.example/cart',
      products: [],
      collections: [],
    };
    const directCheckoutSession = {
      ...cartSession,
      id: 'session-direct',
      startedAt: new Date('2026-09-04T11:00:00.000Z'),
      cartViewCount: 0,
      checkoutStartedAt: new Date('2026-09-04T11:05:00.000Z'),
      checkoutCompletedAt: new Date('2026-09-04T11:10:00.000Z'),
      orderId: 'order-direct',
      landingPageUrl: 'https://shop.example/products/direct-buy',
    };
    vi.mocked(repository.findSessionsForWindow)
      .mockResolvedValueOnce([cartSession, directCheckoutSession] as never)
      .mockResolvedValueOnce([] as never);
    vi.mocked(repository.findValidOrders).mockResolvedValue([
      { id: 'order-cart', lineItems: [] },
      { id: 'order-direct', lineItems: [] },
    ] as never);

    const service = new PixelBehaviorService(repository, () => now);
    await service.rebuildStoreDate(storeId, 'UTC', '2026-09-04');

    const rows = vi.mocked(repository.replaceDailyRows).mock.calls[0]?.[2] ?? [];
    const store = rows.find((row) => row.dimension === 'STORE');
    expect(store).toMatchObject({
      sessionCount: 2,
      cartViewCount: 2,
      cartViewSessionCount: 1,
      cartViewCheckoutSessionCount: 1,
      cartViewPurchaseSessionCount: 1,
      checkoutStartSessionCount: 2,
      linkedPurchaseSessionCount: 2,
    });
  });

  it('uses overlap counters for cart-view rates even when unrelated conversions are more numerous', async () => {
    const repository = behaviorRepository();
    vi.mocked(repository.getStoreContext).mockResolvedValue({
      id: storeId,
      ianaTimezone: 'UTC',
      pixelInstallation: { status: 'ACTIVE', lastEventAt: now },
      storefrontBehaviorRollup: {
        rolledThroughMaterializedAt: now,
        lastRolledUpAt: now,
        lastError: null,
      },
    } as never);
    vi.mocked(repository.aggregateStore)
      .mockResolvedValueOnce({
        _sum: {
          sessionCount: 8,
          cartViewCount: 5,
          cartViewSessionCount: 2,
          cartViewCheckoutSessionCount: 1,
          cartViewPurchaseSessionCount: 1,
          checkoutStartSessionCount: 6,
          linkedPurchaseSessionCount: 4,
        },
      } as never)
      .mockResolvedValueOnce({ _sum: {} } as never);

    const service = new PixelBehaviorService(repository, () => now);
    const overview = await service.overview(storeId, { days: 1 });

    expect(overview.current).toMatchObject({
      cartViews: 5,
      cartViewSessions: 2,
      cartViewCheckoutSessions: 1,
      cartViewPurchaseSessions: 1,
      checkoutStartSessions: 6,
      linkedPurchaseSessions: 4,
      cartViewRate: 0.25,
      cartViewToCheckoutRate: 0.5,
      cartViewToPurchaseRate: 0.5,
    });
    expect(overview.current.cartViewToCheckoutRate).toBeLessThanOrEqual(1);
    expect(overview.current.cartViewToPurchaseRate).toBeLessThanOrEqual(1);
  });
});
