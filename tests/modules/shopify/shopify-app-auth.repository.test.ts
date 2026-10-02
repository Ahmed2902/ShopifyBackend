import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { ShopifyEmbeddedAuthRepository } from '../../../src/modules/shopify/embedded/shopify-embedded-auth.repository.js';
import { ShopifyWebhookRepository } from '../../../src/modules/shopify/webhook/shopify-webhook.repository.js';
const db = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const storeIds = new Set<string>();
const userIds = new Set<string>();
afterEach(async () => {
  for (const id of storeIds) {
    const store = await prisma.store.findUnique({ where: { id }, select: { shopifyShopId: true } });
    if (store)
      await prisma.externalPayload.deleteMany({
        where: { provider: 'SHOPIFY', resourceType: 'Shop', externalId: store.shopifyShopId },
      });
    await prisma.shopifyConnection.deleteMany({ where: { storeId: id } });
    await prisma.store.delete({ where: { id } });
  }
  for (const id of userIds) await prisma.user.delete({ where: { id } });
  storeIds.clear();
  userIds.clear();
});
db('Shopify app provisioning', () => {
  it('expires a fresh old entitlement even while delayed uninstall leaves ACTIVE status, and rejects that old delivery', async () => {
    const unique = randomUUID();
    const shop = `${unique}.myshopify.com`;
    const before = new Date(Date.now() - 3600_000);
    const verifiedAt = new Date();
    const input = {
      shop,
      shopifyUserId: '123',
      apiVersion: '2026-07',
      profile: {
        id: `gid://shopify/Shop/${unique}`,
        name: 'Reinstalled',
        myshopifyDomain: shop,
        currencyCode: 'USD',
        ianaTimezone: 'UTC',
        primaryDomain: null,
        enabledPresentmentCurrencies: ['USD'],
        createdAt: before.toISOString(),
      },
      associatedUser: { id: '123', account_owner: true, collaborator: false, email_verified: true },
      credentials: {
        accessTokenCiphertext: 'old-token',
        refreshTokenCiphertext: 'old-refresh',
        accessTokenExpiresAt: new Date(Date.now() + 3600_000),
        refreshTokenExpiresAt: new Date(Date.now() + 7200_000),
        scopes: ['read_orders'],
        verifiedAt: before,
        installationId: 'gid://shopify/AppInstallation/1',
      },
    };
    const repo = new ShopifyEmbeddedAuthRepository();
    const first = await repo.provision(input);
    storeIds.add(first.storeId);
    userIds.add(first.userId);
    await prisma.storeSubscription.create({
      data: {
        storeId: first.storeId,
        provider: 'SHOPIFY',
        status: 'ACTIVE',
        selectedPlan: 'PRO',
        trialStartedAt: before,
        trialEndsAt: before,
        lastVerifiedAt: before,
        currentPeriodEndsAt: new Date(Date.now() + 86400_000),
        shopifyAppSubscriptionId: `subscription-${unique}`,
        shopifyPlanHandle: 'pro',
      },
    });
    const connection = await prisma.shopifyConnection.findUniqueOrThrow({
      where: { storeId: first.storeId },
    });
    expect(connection.status).toBe('ACTIVE');
    await repo.provision({
      ...input,
      credentials: { ...input.credentials, verifiedAt: new Date(before.getTime() + 500) },
    });
    expect(
      await prisma.storeSubscription.findUnique({ where: { storeId: first.storeId } }),
    ).toMatchObject({ status: 'ACTIVE', lastVerifiedAt: before });
    expect(
      await prisma.shopifyConnection.findUnique({ where: { id: connection.id } }),
    ).toMatchObject({ installedAt: before });
    expect(
      await repo.provision({
        ...input,
        credentials: {
          ...input.credentials,
          accessTokenCiphertext: 'new-token',
          verifiedAt,
          installationId: 'gid://shopify/AppInstallation/2',
        },
      }),
    ).toEqual(first);
    expect(
      await prisma.storeSubscription.findUnique({ where: { storeId: first.storeId } }),
    ).toMatchObject({
      status: 'EXPIRED',
      lastVerifiedAt: null,
      shopifyAppSubscriptionId: null,
      currentPeriodEndsAt: null,
    });
    const webhooks = new ShopifyWebhookRepository();
    expect(
      await webhooks.markConnectionUninstalled(connection.id, new Date(before.getTime() + 1000)),
    ).toBe(false);
    expect(
      await prisma.shopifyConnection.findUnique({ where: { id: connection.id } }),
    ).toMatchObject({
      status: 'ACTIVE',
      installedAt: verifiedAt,
      accessTokenCiphertext: 'new-token',
    });
    await expect(repo.provision(input)).rejects.toMatchObject({
      code: 'SHOPIFY_INSTALLATION_SUPERSEDED',
    });
    // An ordinary reopen of that same installation must not advance installedAt, otherwise
    // an actual uninstall sent before the reopen could be incorrectly ignored.
    await repo.provision({
      ...input,
      credentials: {
        ...input.credentials,
        accessTokenCiphertext: 'new-token',
        verifiedAt: new Date(verifiedAt.getTime() + 500),
        installationId: 'gid://shopify/AppInstallation/2',
      },
    });
    expect(
      await prisma.shopifyConnection.findUnique({ where: { id: connection.id } }),
    ).toMatchObject({ installedAt: verifiedAt });
    expect(
      await webhooks.markConnectionUninstalled(
        connection.id,
        new Date(verifiedAt.getTime() + 1000),
      ),
    ).toBe(true);
    await expect(repo.provision({ ...input, credentials: { ...input.credentials,
      installationId: 'gid://shopify/AppInstallation/2', verifiedAt: new Date(verifiedAt.getTime() + 750),
    } })).rejects.toMatchObject({ code: 'SHOPIFY_INSTALLATION_REVOKED' });
    expect(await prisma.shopifyConnection.findUnique({ where: { id: connection.id } })).toMatchObject({ status: 'UNINSTALLED' });
  });

  it('coalesces concurrent first opens and never promotes the first staff member to owner', async () => {
    const unique = randomUUID();
    const shop = `${unique}.myshopify.com`;
    const input = {
      shop,
      shopifyUserId: '123',
      apiVersion: '2026-07',
      profile: {
        id: `gid://shopify/Shop/${unique}`,
        name: 'Test',
        myshopifyDomain: shop,
        currencyCode: 'USD',
        ianaTimezone: 'UTC',
        primaryDomain: null,
        enabledPresentmentCurrencies: ['USD'],
        createdAt: new Date().toISOString(),
      },
      associatedUser: { id: '123', account_owner: false, collaborator: true, email_verified: true },
    };
    const repository = new ShopifyEmbeddedAuthRepository();
    const results = await Promise.all([repository.provision(input), repository.provision(input)]);
    for (const result of results) {
      storeIds.add(result.storeId);
      userIds.add(result.userId);
    }
    expect(results[0]).toEqual(results[1]);
    expect(results[0].role).toBe('MEMBER');
    expect(await prisma.shopifyUserIdentity.count({ where: { storeId: results[0].storeId } })).toBe(
      1,
    );
    const owner = await repository.provision({
      ...input,
      shopifyUserId: '456',
      associatedUser: {
        ...input.associatedUser,
        id: '456',
        account_owner: true,
        collaborator: false,
      },
    });
    userIds.add(owner.userId);
    expect(owner.role).toBe('OWNER');
    const refreshed = await repository.refreshIdentity(owner.storeId, '456', {
      ...input.associatedUser,
      id: '456',
    });
    expect(refreshed?.role).toBe('MEMBER');
    expect(
      (
        await prisma.storeMembership.findUnique({
          where: { userId_storeId: { userId: owner.userId, storeId: owner.storeId } },
        })
      )?.role,
    ).toBe('MEMBER');
  });
});
