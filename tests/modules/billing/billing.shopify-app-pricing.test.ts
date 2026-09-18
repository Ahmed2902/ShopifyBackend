import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  ShopifyAppPricingClient,
  ShopifyAppPricingSubscription,
} from '../../../src/modules/billing/shopify-app-pricing.client.js';

const subscriptionRepository = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));
const storeRepository = vi.hoisted(() => ({
  findUnique: vi.fn(),
}));

vi.mock('../../../src/lib/prisma.js', () => ({
  prisma: {
    storeSubscription: subscriptionRepository,
    store: storeRepository,
  },
}));

import { BillingService } from '../../../src/modules/billing/billing.service.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const now = new Date('2026-09-18T01:00:00.000Z');

function localSubscription(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    storeId,
    selectedPlan: 'ESSENTIALS',
    status: 'EXPIRED',
    provider: 'INTERNAL',
    essentialsAdProvider: null,
    trialStartedAt: new Date('2026-09-01T00:00:00.000Z'),
    trialEndsAt: new Date('2026-09-15T00:00:00.000Z'),
    currentPeriodEndsAt: null,
    canceledAt: null,
    cancelAtEndOfCycle: false,
    shopifyAppSubscriptionId: null,
    shopifyPlanHandle: null,
    lastVerifiedAt: null,
    createdAt: new Date('2026-09-01T00:00:00.000Z'),
    updatedAt: new Date('2026-09-01T00:00:00.000Z'),
    ...overrides,
  };
}

function remoteSubscription(
  handle: string,
  overrides: Partial<ShopifyAppPricingSubscription> = {},
): ShopifyAppPricingSubscription {
  return {
    shop: {
      id: 'gid://shopify/Shop/123',
      myshopifyDomain: 'stride-test.myshopify.com',
    },
    billingPeriod: 'EVERY_30_DAYS',
    cancelAtEndOfCycle: false,
    trialEndsAt: '2026-09-17T01:00:00.000Z',
    currentBillingCycle: {
      startTime: '2026-09-17T01:00:00.000Z',
      endTime: '2026-10-17T01:00:00.000Z',
    },
    items: [
      {
        handle,
        description: null,
        price: {
          __typename: 'FlatRatePrice',
          active: true,
          currency: 'USD',
          amount: handle === 'stride-pro' ? '99.00' : '49.00',
        },
      },
    ],
    legacySubscriptionId: 'gid://shopify/AppSubscription/999',
    ...overrides,
  };
}

function pricingClient() {
  return {
    isEnabled: vi.fn(() => true),
    activeSubscription: vi.fn(),
    planHandles: vi.fn(() => ({
      ESSENTIALS: 'stride-essentials',
      PRO: 'stride-pro',
    })),
    planSelectionUrl: vi.fn(
      () => 'https://admin.shopify.com/store/stride-test/charges/stride/pricing_plans',
    ),
  } as unknown as ShopifyAppPricingClient;
}

function makeUpdateReturn(current: ReturnType<typeof localSubscription>) {
  subscriptionRepository.update.mockImplementation(async ({ data }: { data: Record<string, unknown> }) => ({
    ...current,
    ...data,
    updatedAt: now,
  }));
}

describe('BillingService Shopify App Pricing verification', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    storeRepository.findUnique.mockResolvedValue({ shopifyShopId: 'gid://shopify/Shop/123' });
  });

  it('maps a verified Shopify Pro subscription into active local billing state', async () => {
    const current = localSubscription();
    const client = pricingClient();
    subscriptionRepository.findUnique.mockResolvedValue(current);
    makeUpdateReturn(current);
    vi.mocked(client.activeSubscription).mockResolvedValue(remoteSubscription('stride-pro'));

    const result = await new BillingService(client).read(storeId, now, {
      fresh: true,
      failOnVerificationError: true,
    });

    expect(client.activeSubscription).toHaveBeenCalledWith('gid://shopify/Shop/123');
    expect(subscriptionRepository.update).toHaveBeenCalledWith({
      where: { storeId },
      data: expect.objectContaining({
        provider: 'SHOPIFY',
        selectedPlan: 'PRO',
        status: 'ACTIVE',
        currentPeriodEndsAt: new Date('2026-10-17T01:00:00.000Z'),
        canceledAt: null,
        shopifyAppSubscriptionId: 'gid://shopify/AppSubscription/999',
        shopifyPlanHandle: 'stride-pro',
        cancelAtEndOfCycle: false,
        lastVerifiedAt: now,
      }),
    });
    expect(result).toMatchObject({
      provider: 'SHOPIFY',
      selectedPlan: 'PRO',
      effectivePlan: 'PRO',
      accessActive: true,
      verification: {
        source: 'SHOPIFY_PARTNER_API',
        lastVerifiedAt: now,
        stale: false,
      },
    });
  });

  it('maps an active Essentials subscription by configured plan handle', async () => {
    const current = localSubscription({ provider: 'SHOPIFY' });
    const client = pricingClient();
    subscriptionRepository.findUnique.mockResolvedValue(current);
    makeUpdateReturn(current);
    vi.mocked(client.activeSubscription).mockResolvedValue(
      remoteSubscription('stride-essentials'),
    );

    const result = await new BillingService(client).read(storeId, now, {
      fresh: true,
      failOnVerificationError: true,
    });

    expect(result).toMatchObject({
      provider: 'SHOPIFY',
      selectedPlan: 'ESSENTIALS',
      effectivePlan: 'ESSENTIALS',
      status: 'ACTIVE',
      accessActive: true,
    });
  });

  it('revokes paid access when Shopify no longer reports an active subscription', async () => {
    const current = localSubscription({
      provider: 'SHOPIFY',
      status: 'ACTIVE',
      selectedPlan: 'PRO',
      shopifyAppSubscriptionId: 'gid://shopify/AppSubscription/999',
      shopifyPlanHandle: 'stride-pro',
    });
    const client = pricingClient();
    subscriptionRepository.findUnique.mockResolvedValue(current);
    makeUpdateReturn(current);
    vi.mocked(client.activeSubscription).mockResolvedValue(null);

    const result = await new BillingService(client).read(storeId, now, {
      fresh: true,
      failOnVerificationError: true,
    });

    expect(subscriptionRepository.update).toHaveBeenCalledWith({
      where: { storeId },
      data: expect.objectContaining({
        provider: 'SHOPIFY',
        status: 'CANCELED',
        currentPeriodEndsAt: null,
        canceledAt: now,
        shopifyAppSubscriptionId: null,
        shopifyPlanHandle: null,
        cancelAtEndOfCycle: false,
        lastVerifiedAt: now,
      }),
    });
    expect(result).toMatchObject({
      status: 'CANCELED',
      provider: 'SHOPIFY',
      accessActive: false,
      trial: { active: false },
    });
  });

  it('fails closed when Shopify reports an unrecognized active plan handle', async () => {
    const current = localSubscription({ provider: 'SHOPIFY' });
    const client = pricingClient();
    subscriptionRepository.findUnique.mockResolvedValue(current);
    vi.mocked(client.activeSubscription).mockResolvedValue(remoteSubscription('unexpected-plan'));

    await expect(
      new BillingService(client).read(storeId, now, {
        fresh: true,
        failOnVerificationError: true,
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'SHOPIFY_PLAN_UNRECOGNIZED',
    });

    expect(subscriptionRepository.update).not.toHaveBeenCalled();
  });
});
