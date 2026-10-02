import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { BillingService } from '../../../src/modules/billing/billing.service.js';
import type { ShopifyAppPricingClient, ShopifyAppPricingSubscription } from '../../../src/modules/billing/shopify-app-pricing.client.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const stores: string[] = [];
afterEach(async () => {
  for (const id of stores.splice(0)) {
    await prisma.shopifyConnection.deleteMany({ where: { storeId: id } });
    await prisma.store.delete({ where: { id } });
  }
});

function client(read: () => Promise<ShopifyAppPricingSubscription | null>) {
  return {
    isEnabled: () => true, activeSubscription: vi.fn(read),
    planHandles: () => ({ ESSENTIALS: 'stride-essentials', PRO: 'stride-pro' }),
    planSelectionUrl: () => 'https://admin.shopify.com/store/test/charges/stride/pricing_plans',
  } as unknown as ShopifyAppPricingClient;
}

describeDatabase('Billing verification across installation generations', () => {
  it.each(['absent', 'invalid', 'grant'].flatMap(result => [true, false].map(reinstall => ({ result, reinstall }))))('does not overwrite newer verification with an old $result result (reinstall=$reinstall)', async ({ result, reinstall }) => {
    const unique = randomUUID();
    const oldInstalledAt = new Date(Date.now() - 86400_000);
    const store = await prisma.store.create({ data: {
      shopifyShopId: `gid://shopify/Shop/${unique}`, name: 'Billing generation test',
      myshopifyDomain: `billing-generation-${unique}.myshopify.com`, currencyCode: 'USD', ianaTimezone: 'UTC',
      shopifyConnection: { create: { status: 'ACTIVE', installedAt: oldInstalledAt,
        accessTokenCiphertext: 'old-token', scopes: [], apiVersion: '2026-07' } },
      subscription: { create: { provider: 'SHOPIFY', status: 'ACTIVE', selectedPlan: 'ESSENTIALS',
        trialStartedAt: oldInstalledAt, trialEndsAt: oldInstalledAt, lastVerifiedAt: oldInstalledAt } },
    }, include: { shopifyConnection: true } });
    stores.push(store.id);
    const remote = (handle: string): ShopifyAppPricingSubscription => ({
      shop: { id: store.shopifyShopId, myshopifyDomain: store.myshopifyDomain },
      billingPeriod: 'EVERY_30_DAYS', cancelAtEndOfCycle: false, trialEndsAt: null,
      currentBillingCycle: { startTime: oldInstalledAt.toISOString(), endTime: new Date(Date.now() + 30 * 86400_000).toISOString() },
      items: [{ handle, description: null, price: { __typename: 'FlatRatePrice', active: true,
        currency: 'USD', amount: handle === 'stride-pro' ? '84.99' : '49.99' } }],
      legacySubscriptionId: `gid://shopify/AppSubscription/${unique}`,
    });
    let release!: (value: ShopifyAppPricingSubscription | null) => void;
    let signalStarted!: () => void;
    const started = new Promise<void>(resolve => { signalStarted = resolve; });
    const oldRead = new BillingService(client(() => {
      signalStarted();
      return new Promise(resolve => { release = resolve; });
    })).read(store.id, new Date(), { fresh: true, failOnVerificationError: true });
    await started;
    const reinstalledAt = new Date();
    if (reinstall) {
      await prisma.shopifyConnection.update({ where: { id: store.shopifyConnection!.id },
        data: { installedAt: reinstalledAt, status: 'ACTIVE', accessTokenCiphertext: 'new-token' } });
      await prisma.storeSubscription.update({ where: { storeId: store.id },
        data: { status: 'EXPIRED', lastVerifiedAt: null } });
    }
    await new BillingService(client(async () => remote('stride-pro'))).read(store.id, reinstalledAt,
      { fresh: true, failOnVerificationError: true });
    release(result === 'absent' ? null : remote(result === 'invalid' ? 'unrecognized' : 'stride-essentials'));
    await expect(oldRead).rejects.toMatchObject({ code: 'P2025' });
    expect(await prisma.storeSubscription.findUniqueOrThrow({ where: { storeId: store.id } })).toMatchObject({
      status: 'ACTIVE', selectedPlan: 'PRO', lastVerifiedAt: reinstalledAt, shopifyPlanHandle: 'stride-pro',
    });
  });
});
