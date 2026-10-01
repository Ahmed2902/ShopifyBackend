import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { ConversionDeliveryRepository } from '../../../src/modules/conversion-delivery/conversion-delivery.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const stores: string[] = [];
afterEach(async () => { for (const id of stores.splice(0)) await prisma.store.delete({ where: { id } }); });

describeDatabase('Conversion delivery effective billing claims', () => {
  it('claims all providers in an Essentials Shopify trial, then only the selected provider after trial expiry', async () => {
    const now = new Date();
    const unique = randomUUID();
    const store = await prisma.store.create({ data: { shopifyShopId: unique,
      myshopifyDomain: `${unique}.myshopify.com`, name: 'Conversion claim test', currencyCode: 'USD', ianaTimezone: 'UTC' } });
    stores.push(store.id);
    await prisma.storeSubscription.create({ data: { storeId: store.id, provider: 'SHOPIFY', selectedPlan: 'ESSENTIALS',
      status: 'ACTIVE', trialStartedAt: now, trialEndsAt: new Date(now.getTime() + 86400_000), essentialsAdProvider: null } });
    const repository = new ConversionDeliveryRepository();
    for (const provider of ['META', 'TIKTOK', 'GOOGLE_ADS'] as const) {
      const destination = await prisma.conversionDestination.create({ data: { storeId: store.id, provider,
        externalId: `${unique}-${provider}`, configJson: {}, status: 'ACTIVE' } });
      await prisma.conversionDelivery.create({ data: { storeId: store.id, destinationId: destination.id, provider,
        sourceOrderId: randomUUID(), eventKey: `${unique}-${provider}`, shopifyOrderId: `order-${unique}`, eventName: 'PURCHASE', eventAt: now,
        value: '10', currencyCode: 'USD', nextAttemptAt: now } });
    }
    const claims = await repository.claimDue(10, now);
    expect(claims.filter(c => c.storeId === store.id).map(c => c.provider).sort()).toEqual(['GOOGLE_ADS', 'META', 'TIKTOK']);
    for (const claim of claims.filter(c => c.storeId === store.id)) await repository.pauseForBilling(claim.id, now);
    const rows = await prisma.conversionDelivery.findMany({ where: { storeId: store.id } });
    expect(rows.every(row => row.attempts === 0)).toBe(true);
    await prisma.storeSubscription.update({ where: { storeId: store.id }, data: { trialEndsAt: now, essentialsAdProvider: 'META' } });
    const paidClaims = await repository.claimDue(10, now);
    expect(paidClaims.filter(c => c.storeId === store.id).map(c => c.provider)).toEqual(['META']);
    await prisma.storeSubscription.update({ where: { storeId: store.id }, data: { status: 'EXPIRED' } });
    expect((await repository.claimDue(10, now)).filter(c => c.storeId === store.id)).toHaveLength(0);
  });
});
