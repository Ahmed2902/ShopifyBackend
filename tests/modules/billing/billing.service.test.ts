import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { BillingService } from '../../../src/modules/billing/billing.service.js';

const storeIds: string[] = [];

async function createStore() {
  const suffix = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${suffix}`,
      name: 'Billing Test Store',
      myshopifyDomain: `billing-${suffix}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: 'America/New_York',
    },
  });
  storeIds.push(store.id);
  return store;
}

afterEach(async () => {
  if (storeIds.length) await prisma.store.deleteMany({ where: { id: { in: storeIds.splice(0) } } });
});

describe('BillingService', () => {
  it('starts every new store on a 14-day Pro-equivalent trial', async () => {
    const store = await createStore();
    const now = new Date('2026-09-08T12:00:00.000Z');
    const result = await new BillingService().read(store.id, now);

    expect(result.status).toBe('TRIALING');
    expect(result.selectedPlan).toBe('ESSENTIALS');
    expect(result.effectivePlan).toBe('PRO');
    expect(result.trial.active).toBe(true);
    expect(result.trial.endsAt.toISOString()).toBe('2026-09-22T12:00:00.000Z');
    expect(result.entitlements.maxAdChannels).toBeNull();
    expect(result.entitlements.deepJourneys).toBe(true);
    expect(result.entitlements.advancedAttribution).toBe(true);
  });

  it('expires the internal trial after 14 days', async () => {
    const store = await createStore();
    const service = new BillingService();
    await service.read(store.id, new Date('2026-09-01T00:00:00.000Z'));

    const result = await service.read(store.id, new Date('2026-09-16T00:00:00.000Z'));
    expect(result.status).toBe('EXPIRED');
    expect(result.accessActive).toBe(false);
    await expect(service.requireActive(store.id)).rejects.toMatchObject({
      code: 'SUBSCRIPTION_REQUIRED',
      statusCode: 402,
    });
  });

  it('allows one Essentials ad provider but rejects a second connected provider', async () => {
    const store = await createStore();
    const now = new Date();
    await prisma.storeSubscription.create({
      data: {
        storeId: store.id,
        selectedPlan: 'ESSENTIALS',
        status: 'ACTIVE',
        provider: 'SHOPIFY',
        trialStartedAt: now,
        trialEndsAt: now,
      },
    });
    await prisma.metaConnection.create({
      data: {
        storeId: store.id,
        status: 'ACTIVE',
        accessTokenCiphertext: 'test',
        scopes: [],
        apiVersion: 'v1',
      },
    });

    const service = new BillingService();
    await expect(service.requireAdProvider(store.id, 'META')).resolves.toMatchObject({ effectivePlan: 'ESSENTIALS' });
    await expect(service.requireAdProvider(store.id, 'TIKTOK')).rejects.toMatchObject({
      code: 'PLAN_AD_CHANNEL_LIMIT',
      statusCode: 403,
    });
  });

  it('allows Pro to use multiple ad providers and advanced investigation surfaces', async () => {
    const store = await createStore();
    const now = new Date();
    await prisma.storeSubscription.create({
      data: {
        storeId: store.id,
        selectedPlan: 'PRO',
        status: 'ACTIVE',
        provider: 'SHOPIFY',
        trialStartedAt: now,
        trialEndsAt: now,
      },
    });
    await prisma.metaConnection.create({
      data: {
        storeId: store.id,
        status: 'ACTIVE',
        accessTokenCiphertext: 'test',
        scopes: [],
        apiVersion: 'v1',
      },
    });

    const service = new BillingService();
    await expect(service.requireAdProvider(store.id, 'TIKTOK')).resolves.toMatchObject({ effectivePlan: 'PRO' });
    await expect(service.requireEntitlement(store.id, 'DEEP_JOURNEYS')).resolves.toMatchObject({ effectivePlan: 'PRO' });
    await expect(service.requireEntitlement(store.id, 'ADVANCED_ATTRIBUTION')).resolves.toMatchObject({ effectivePlan: 'PRO' });
  });
});
