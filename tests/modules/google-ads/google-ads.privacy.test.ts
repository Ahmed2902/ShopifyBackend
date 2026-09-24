import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { ShopifyPrivacyRepository } from '../../../src/modules/shopify/privacy/shopify-privacy.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;

describeDatabase('Google Ads shop-redact privacy integration', () => {
  it('purges Google Ads customer staging and connection before deleting the store', async () => {
    const store = await prisma.store.create({
      data: {
        shopifyShopId: `gid://shopify/Shop/${randomUUID()}`,
        name: 'Google Ads Privacy Store',
        myshopifyDomain: `google-privacy-${randomUUID()}.myshopify.com`,
        currencyCode: 'USD',
        ianaTimezone: 'UTC',
        shopifyConnection: {
          create: {
            status: 'ACTIVE',
            accessTokenCiphertext: 'shopify-token',
            scopes: ['read_orders'],
            apiVersion: '2026-07',
          },
        },
        googleAdsConnection: {
          create: {
            status: 'ACTIVE',
            accessTokenCiphertext: 'encrypted-access-token',
            refreshTokenCiphertext: 'encrypted-refresh-token',
            scopes: ['https://www.googleapis.com/auth/adwords'],
            apiVersion: 'v25',
          },
        },
      },
      select: {
        id: true,
        shopifyConnection: { select: { id: true } },
        googleAdsConnection: { select: { id: true } },
      },
    });

    const customer = await prisma.googleAdsCustomer.create({
      data: {
        storeId: store.id,
        googleAdsConnectionId: store.googleAdsConnection!.id,
        customerId: '1234567890',
        descriptiveName: 'Privacy Google Ads Customer',
        currencyCode: 'USD',
        timeZone: 'UTC',
      },
    });

    const redactDelivery = await prisma.webhookDelivery.create({
      data: {
        provider: 'SHOPIFY',
        externalDeliveryId: `google-shop-redact-${randomUUID()}`,
        shopifyConnectionId: store.shopifyConnection!.id,
        topic: 'shop/redact',
        status: 'PROCESSING',
        payload: { shop_domain: 'sensitive-google-merchant-state' },
      },
    });

    const repository = new ShopifyPrivacyRepository();
    expect(await repository.purgeStore(store.id, redactDelivery.id)).toBe(true);

    expect(await prisma.googleAdsCustomer.findUnique({ where: { id: customer.id } })).toBeNull();
    expect(
      await prisma.googleAdsConnection.findUnique({ where: { id: store.googleAdsConnection!.id } }),
    ).toBeNull();
    expect(await prisma.store.findUnique({ where: { id: store.id } })).toBeNull();

    const audit = await prisma.webhookDelivery.findUnique({ where: { id: redactDelivery.id } });
    expect(audit?.shopifyConnectionId).toBeNull();
    expect(audit?.payload).toEqual({ complianceTopic: 'shop/redact', processed: true });

    await prisma.webhookDelivery.delete({ where: { id: redactDelivery.id } });
  });
});
