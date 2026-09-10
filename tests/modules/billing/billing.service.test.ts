import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShopifyAppPricingClient } from '../../../src/modules/billing/shopify-app-pricing.client.js';

const subscriptionRepository = vi.hoisted(() => ({
  findUnique: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
}));

vi.mock('../../../src/lib/prisma.js', () => ({
  prisma: {
    storeSubscription: subscriptionRepository,
  },
}));

import { BillingService, V1_TRIAL_DAYS } from '../../../src/modules/billing/billing.service.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const startedAt = new Date('2026-09-01T12:00:00.000Z');
const trialEndsAt = new Date(startedAt.getTime() + V1_TRIAL_DAYS * 24 * 60 * 60 * 1000);

function internalTrial(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb',
    storeId,
    selectedPlan: 'ESSENTIALS',
    status: 'TRIALING',
    provider: 'INTERNAL',
    essentialsAdProvider: null,
    trialStartedAt: startedAt,
    trialEndsAt,
    currentPeriodEndsAt: null,
    cancelAtEndOfCycle: false,
    shopifyPlanHandle: null,
    lastVerifiedAt: null,
    createdAt: startedAt,
    updatedAt: startedAt,
    ...overrides,
  };
}

const internalPricing = {
  isEnabled: vi.fn(() => false),
} as unknown as ShopifyAppPricingClient;

describe('BillingService internal trial expiry', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('keeps access active before the 14-day trial boundary', async () => {
    const subscription = internalTrial();
    subscriptionRepository.findUnique.mockResolvedValue(subscription);

    const result = await new BillingService(internalPricing).read(
      storeId,
      new Date(trialEndsAt.getTime() - 1),
    );

    expect(subscriptionRepository.update).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      status: 'TRIALING',
      effectivePlan: 'PRO',
      accessActive: true,
      trial: { active: true, days: 14 },
    });
  });

  it('expires an internal trial exactly at its end timestamp', async () => {
    const subscription = internalTrial();
    const expired = internalTrial({ status: 'EXPIRED', updatedAt: trialEndsAt });
    subscriptionRepository.findUnique.mockResolvedValue(subscription);
    subscriptionRepository.update.mockResolvedValue(expired);

    const result = await new BillingService(internalPricing).read(storeId, trialEndsAt);

    expect(subscriptionRepository.update).toHaveBeenCalledWith({
      where: { storeId },
      data: { status: 'EXPIRED' },
    });
    expect(result).toMatchObject({
      status: 'EXPIRED',
      effectivePlan: 'ESSENTIALS',
      accessActive: false,
      trial: { active: false, endsAt: trialEndsAt },
    });
  });

  it('blocks paid features after an expired internal trial', async () => {
    subscriptionRepository.findUnique.mockResolvedValue(
      internalTrial({ status: 'EXPIRED', updatedAt: trialEndsAt }),
    );

    await expect(new BillingService(internalPricing).requireActive(storeId)).rejects.toMatchObject({
      statusCode: 402,
      code: 'SUBSCRIPTION_REQUIRED',
    });

    expect(subscriptionRepository.update).not.toHaveBeenCalled();
  });
});
