import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { ShopifyEmbeddedAuthRepository } from '../../../src/modules/shopify/embedded/shopify-embedded-auth.repository.js';
const db = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const storeIds = new Set<string>();
const userIds = new Set<string>();
afterEach(async () => {
  for (const id of storeIds) await prisma.store.delete({ where: { id } });
  for (const id of userIds) await prisma.user.delete({ where: { id } });
  storeIds.clear(); userIds.clear();
});
db('Shopify app provisioning', () => {
  it('coalesces concurrent first opens and never promotes the first staff member to owner', async () => {
    const unique = randomUUID();
    const shop = `${unique}.myshopify.com`;
    const input = { shop, shopifyUserId: '123', apiVersion: '2026-07',
      profile: { id: `gid://shopify/Shop/${unique}`, name: 'Test', myshopifyDomain: shop,
        currencyCode: 'USD', ianaTimezone: 'UTC', primaryDomain: null,
        enabledPresentmentCurrencies: ['USD'], createdAt: new Date().toISOString() },
      associatedUser: { id: '123', account_owner: false, collaborator: true, email_verified: true } };
    const repository = new ShopifyEmbeddedAuthRepository();
    const results = await Promise.all([repository.provision(input), repository.provision(input)]);
    for (const result of results) { storeIds.add(result.storeId); userIds.add(result.userId); }
    expect(results[0]).toEqual(results[1]);
    expect(results[0].role).toBe('MEMBER');
    expect(await prisma.shopifyUserIdentity.count({ where: { storeId: results[0].storeId } })).toBe(1);
    const owner = await repository.provision({ ...input, shopifyUserId: '456', associatedUser: { ...input.associatedUser, id: '456', account_owner: true, collaborator: false } });
    userIds.add(owner.userId);
    expect(owner.role).toBe('OWNER');
    const refreshed = await repository.refreshIdentity(owner.storeId, '456', { ...input.associatedUser, id: '456' });
    expect(refreshed?.role).toBe('MEMBER');
    expect((await prisma.storeMembership.findUnique({ where: { userId_storeId: { userId: owner.userId, storeId: owner.storeId } } }))?.role).toBe('MEMBER');
  });
});
