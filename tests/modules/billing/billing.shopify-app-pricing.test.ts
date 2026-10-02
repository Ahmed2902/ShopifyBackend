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
          amount: handle === 'stride-pro' ? '84.99' : '49.99',
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
  subscriptionRepository.update.mockImplementation(
    async ({ data }: { data: Record<string, unknown> }) => ({
      ...current,
      ...data,
      updatedAt: now,
    }),
  );
}

describe('BillingService Shopify App Pricing verification', () => {
  it('rejects even a freshly verified cached grant after uninstall', async () => {
    const client = pricingClient();
    subscriptionRepository.findUnique.mockResolvedValue(localSubscription({ provider: 'SHOPIFY', status: 'ACTIVE', lastVerifiedAt: new Date() }));
    storeRepository.findUnique.mockResolvedValue({ shopifyConnection: { status: 'UNINSTALLED' } });
    await expect(new BillingService(client).requireActive(storeId)).rejects.toMatchObject({ code: 'SHOPIFY_INSTALL_REQUIRED' });
    expect(client.activeSubscription).not.toHaveBeenCalled();
  });
  it('revokes a previously active cached grant when background reconciliation sees a deterministic price mismatch', async () => {
    let persisted = localSubscription({ provider: 'SHOPIFY', status: 'ACTIVE', selectedPlan: 'PRO',
      lastVerifiedAt: new Date(now.getTime() - 86400_000) });
    const client = pricingClient();
    subscriptionRepository.findUnique.mockImplementation(async () => persisted);
    subscriptionRepository.update.mockImplementation(async ({ data }) => { persisted = { ...persisted, ...data }; return persisted; });
    const remote = remoteSubscription('stride-pro');
    remote.items[0]!.price.amount = '99.00';
    vi.mocked(client.activeSubscription).mockResolvedValue(remote);
    const service = new BillingService(client);
    await expect(service.refreshFromShopify(storeId)).rejects.toMatchObject({ code: 'SHOPIFY_PLAN_CONFIGURATION_MISMATCH' });
    expect(persisted.status).toBe('EXPIRED');
    await expect(service.requireActive(storeId)).rejects.toMatchObject({ code: 'SUBSCRIPTION_REQUIRED' });
  });
  beforeEach(() => {
    vi.clearAllMocks();
    storeRepository.findUnique.mockResolvedValue({ shopifyShopId: 'gid://shopify/Shop/123', myshopifyDomain: 'stride-test.myshopify.com', shopifyConnection: { status: 'ACTIVE' } });
  });

  it('maps a verified $84.99 Shopify Pro subscription into active local billing state', async () => {
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
      where: expect.objectContaining({ storeId }),
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
      entitlements: {
        maxAdChannels: null,
        recommendationLimit: 50,
        visitorJourneys: true,
        advancedAttribution: true,
        crossChannelIntelligence: true,
        serverSideConversions: 'ALL_CONFIGURED_PROVIDERS',
      },
    });
  });

  it('maps a verified $49.99 Essentials subscription by configured plan handle', async () => {
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
      entitlements: {
        maxAdChannels: 1,
        recommendationLimit: 10,
        visitorJourneys: false,
        advancedAttribution: false,
        crossChannelIntelligence: false,
        serverSideConversions: 'SELECTED_PROVIDER',
      },
    });
  });

  it('grants Pro entitlements while a Shopify-hosted trial is active', async () => {
    const current = localSubscription({ provider: 'SHOPIFY' });
    const client = pricingClient();
    subscriptionRepository.findUnique.mockResolvedValue(current);
    makeUpdateReturn(current);
    vi.mocked(client.activeSubscription).mockResolvedValue(
      remoteSubscription('stride-essentials', { trialEndsAt: '2026-09-25T01:00:00.000Z' }),
    );

    const result = await new BillingService(client).read(storeId, now, {
      fresh: true,
      failOnVerificationError: true,
    });

    expect(result).toMatchObject({
      selectedPlan: 'ESSENTIALS',
      effectivePlan: 'PRO',
      trial: { active: true, days: 14, grantsProEntitlements: true },
      entitlements: { maxAdChannels: null, recommendationLimit: 50 },
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
      where: expect.objectContaining({ storeId, store: expect.any(Object) }),
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

    expect(subscriptionRepository.update).toHaveBeenCalledWith({ where: expect.objectContaining({ storeId, store: expect.any(Object) }),
      data: expect.objectContaining({ status: 'EXPIRED', trialEndsAt: now, lastVerifiedAt: now }) });
  });

  it('fails closed if the Shopify plan handle exists but the configured price is stale', async () => {
    const current = localSubscription({ provider: 'SHOPIFY' });
    const client = pricingClient();
    subscriptionRepository.findUnique.mockResolvedValue(current);
    vi.mocked(client.activeSubscription).mockResolvedValue(
      remoteSubscription('stride-pro', {
        items: [
          {
            handle: 'stride-pro',
            description: null,
            price: {
              __typename: 'FlatRatePrice',
              active: true,
              currency: 'USD',
              amount: '99.00',
            },
          },
        ],
      }),
    );

    await expect(
      new BillingService(client).read(storeId, now, {
        fresh: true,
        failOnVerificationError: true,
      }),
    ).rejects.toMatchObject({
      statusCode: 503,
      code: 'SHOPIFY_PLAN_CONFIGURATION_MISMATCH',
      details: expect.objectContaining({
        plan: 'PRO',
        expected: expect.objectContaining({ amount: '84.99', currency: 'USD' }),
      }),
    });

    expect(subscriptionRepository.update).toHaveBeenCalledWith({ where: expect.objectContaining({ storeId, store: expect.any(Object) }),
      data: expect.objectContaining({ status: 'EXPIRED', trialEndsAt: now, lastVerifiedAt: now }) });
  });

  it('fails closed if currency or billing period differs from the launch contract', async () => {
    const current = localSubscription({ provider: 'SHOPIFY' });
    const client = pricingClient();
    subscriptionRepository.findUnique.mockResolvedValue(current);
    vi.mocked(client.activeSubscription).mockResolvedValue(
      remoteSubscription('stride-essentials', {
        billingPeriod: 'ANNUAL',
        items: [
          {
            handle: 'stride-essentials',
            description: null,
            price: {
              __typename: 'FlatRatePrice',
              active: true,
              currency: 'EUR',
              amount: '49.99',
            },
          },
        ],
      }),
    );

    await expect(
      new BillingService(client).read(storeId, now, {
        fresh: true,
        failOnVerificationError: true,
      }),
    ).rejects.toMatchObject({ code: 'SHOPIFY_PLAN_CONFIGURATION_MISMATCH' });
  });
  it.each(['id', 'myshopifyDomain'] as const)('revokes a contract belonging to a different shop (%s)', async (field) => {
    const current = localSubscription({ provider: 'SHOPIFY', status: 'ACTIVE' });
    subscriptionRepository.findUnique.mockResolvedValue(current); makeUpdateReturn(current);
    const client = pricingClient(); const remote = remoteSubscription('stride-pro');
    remote.shop[field] = field === 'id' ? 'gid://shopify/Shop/9999' : 'other.myshopify.com';
    vi.mocked(client.activeSubscription).mockResolvedValue(remote);
    await expect(new BillingService(client).read(storeId, now, { fresh: true })).rejects.toMatchObject({ code: 'SHOPIFY_PLAN_CONFIGURATION_MISMATCH' });
    expect(subscriptionRepository.update).toHaveBeenCalledWith({ where: expect.objectContaining({ storeId, store: expect.any(Object) }), data: expect.objectContaining({ status: 'EXPIRED' }) });
  });

  it.each([true, false])('accepts a zero-dollar contract only when the Admin API verifies a development store (%s)', async (development) => {
    const current = localSubscription(); subscriptionRepository.findUnique.mockResolvedValue(current); makeUpdateReturn(current);
    const client = pricingClient(); const remote = remoteSubscription('stride-pro'); remote.items[0]!.price.amount = '0.00';
    vi.mocked(client.activeSubscription).mockResolvedValue(remote);
    const verify = vi.fn().mockResolvedValue(development);
    const result = new BillingService(client, verify).read(storeId, now, { fresh: true, failOnVerificationError: true });
    if (development) await expect(result).resolves.toMatchObject({ selectedPlan: 'PRO', accessActive: true });
    else await expect(result).rejects.toMatchObject({ code: 'SHOPIFY_PLAN_CONFIGURATION_MISMATCH' });
    expect(verify).toHaveBeenCalledWith(storeId, 'gid://shopify/Shop/123');
  });

  it('fails closed if development-store verification is unavailable', async () => {
    const current = localSubscription(); subscriptionRepository.findUnique.mockResolvedValue(current);
    const client = pricingClient(); const remote = remoteSubscription('stride-pro'); remote.items[0]!.price.amount = '0';
    vi.mocked(client.activeSubscription).mockResolvedValue(remote);
    await expect(new BillingService(client, vi.fn().mockRejectedValue(new Error('offline'))).read(storeId, now, { fresh: true, failOnVerificationError: true })).rejects.toThrow('offline');
    expect(subscriptionRepository.update).not.toHaveBeenCalled();
  });

  it('does not contact Partner API or grant access to an uninstalled store', async () => {
    const current = localSubscription({ provider: 'SHOPIFY', status: 'ACTIVE' });
    subscriptionRepository.findUnique.mockResolvedValue(current); makeUpdateReturn(current);
    storeRepository.findUnique.mockResolvedValue({ shopifyShopId: 'gid://shopify/Shop/123', myshopifyDomain: 'stride-test.myshopify.com', shopifyConnection: { status: 'UNINSTALLED' } });
    const client = pricingClient();
    await expect(new BillingService(client).read(storeId, now, { fresh: true })).resolves.toMatchObject({ accessActive: false });
    expect(client.activeSubscription).not.toHaveBeenCalled();
  });

  it('never grants the old internal trial once Shopify App Pricing is enabled', async () => {
    subscriptionRepository.findUnique.mockResolvedValue(localSubscription({ status: 'TRIALING', trialEndsAt: new Date(now.getTime() + 86400_000) }));
    await expect(new BillingService(pricingClient()).readLocal(storeId, now)).resolves.toMatchObject({ accessActive: false, trial: { active: false } });
  });

});
