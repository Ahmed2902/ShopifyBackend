import { createHash } from 'node:crypto';
import type { Prisma } from '../../../generated/prisma/client.js';
import { prisma } from '../../../lib/prisma.js';
import type { ShopifyShopProfile } from '../shopify.schema.js';
import type { ShopifyAssociatedUser } from './shopify-embedded.schema.js';

export type EmbeddedOfflineCredentials = {
  accessTokenCiphertext: string;
  accessTokenExpiresAt: Date;
  refreshTokenCiphertext: string;
  refreshTokenExpiresAt: Date;
  scopes: string[];
};

function syntheticIdentityEmail(shop: string, shopifyUserId: string): string {
  const digest = createHash('sha256')
    .update(`${shop}\u0000${shopifyUserId}`)
    .digest('hex')
    .slice(0, 32);
  return `shopify-${digest}@identity.invalid`;
}

function authoritativeRole(accountOwner: boolean): 'OWNER' | 'MEMBER' {
  // The Shopify ID/online token gives us a trustworthy account-owner bit, but it doesn't encode
  // Stride's ADMIN concept. Never guess elevated permissions for staff/collaborators.
  return accountOwner ? 'OWNER' : 'MEMBER';
}

export class ShopifyEmbeddedAuthRepository {
  findStoreByShop(shop: string) {
    return prisma.store.findUnique({
      where: { myshopifyDomain: shop },
      select: {
        id: true,
        shopifyShopId: true,
        myshopifyDomain: true,
        shopifyConnection: {
          select: {
            id: true,
            status: true,
          },
        },
      },
    });
  }

  async findIdentity(storeId: string, shopifyUserId: string) {
    const identity = await prisma.shopifyUserIdentity.findUnique({
      where: { storeId_shopifyUserId: { storeId, shopifyUserId } },
      select: {
        userId: true,
        accountOwner: true,
        collaborator: true,
      },
    });
    if (!identity) return null;

    await prisma.shopifyUserIdentity.update({
      where: { storeId_shopifyUserId: { storeId, shopifyUserId } },
      data: { lastSeenAt: new Date() },
    });

    return {
      userId: identity.userId,
      role: authoritativeRole(identity.accountOwner),
      accountOwner: identity.accountOwner,
      collaborator: identity.collaborator,
    };
  }

  async refreshIdentity(
    storeId: string,
    shopifyUserId: string,
    associatedUser: ShopifyAssociatedUser,
  ) {
    const identity = await prisma.shopifyUserIdentity.findUnique({
      where: { storeId_shopifyUserId: { storeId, shopifyUserId } },
      select: { userId: true },
    });
    if (!identity) return null;

    const role = authoritativeRole(associatedUser.account_owner);
    return prisma.$transaction(async (tx) => {
      await tx.shopifyUserIdentity.update({
        where: { storeId_shopifyUserId: { storeId, shopifyUserId } },
        data: {
          accountOwner: associatedUser.account_owner,
          collaborator: associatedUser.collaborator,
          emailVerified: associatedUser.email_verified,
          lastSeenAt: new Date(),
        },
      });
      await tx.storeMembership.upsert({
        where: { userId_storeId: { userId: identity.userId, storeId } },
        create: { userId: identity.userId, storeId, role },
        update: { role },
      });
      return { userId: identity.userId, role };
    });
  }

  async provision(input: {
    shop: string;
    shopifyUserId: string;
    profile: ShopifyShopProfile;
    associatedUser: ShopifyAssociatedUser;
    apiVersion: string;
    credentials?: EmbeddedOfflineCredentials;
  }) {
    return prisma.$transaction(async (tx) => {
      const candidates = await tx.store.findMany({
        where: {
          OR: [
            { shopifyShopId: input.profile.id },
            { myshopifyDomain: input.shop },
          ],
        },
        select: { id: true },
        take: 2,
      });
      if (candidates.length > 1) {
        throw new Error('Shopify shop identity resolves to conflicting Stride stores');
      }

      const storeData = {
        shopifyShopId: input.profile.id,
        name: input.profile.name,
        myshopifyDomain: input.shop,
        currencyCode: input.profile.currencyCode,
        ianaTimezone: input.profile.ianaTimezone,
        primaryDomainHost: input.profile.primaryDomain?.host ?? null,
        primaryDomainUrl: input.profile.primaryDomain?.url ?? null,
        enabledPresentmentCurrencies: input.profile.enabledPresentmentCurrencies,
        shopifyCreatedAt: new Date(input.profile.createdAt),
      };

      const store = candidates[0]
        ? await tx.store.update({
            where: { id: candidates[0].id },
            data: storeData,
            select: { id: true },
          })
        : await tx.store.create({ data: storeData, select: { id: true } });

      if (input.credentials) {
        const now = new Date();
        await tx.shopifyConnection.upsert({
          where: { storeId: store.id },
          create: {
            storeId: store.id,
            status: 'ACTIVE',
            accessTokenCiphertext: input.credentials.accessTokenCiphertext,
            accessTokenExpiresAt: input.credentials.accessTokenExpiresAt,
            refreshTokenCiphertext: input.credentials.refreshTokenCiphertext,
            refreshTokenExpiresAt: input.credentials.refreshTokenExpiresAt,
            scopes: input.credentials.scopes,
            apiVersion: input.apiVersion,
            nextReconciliationAt: now,
          },
          update: {
            status: 'ACTIVE',
            accessTokenCiphertext: input.credentials.accessTokenCiphertext,
            accessTokenExpiresAt: input.credentials.accessTokenExpiresAt,
            refreshTokenCiphertext: input.credentials.refreshTokenCiphertext,
            refreshTokenExpiresAt: input.credentials.refreshTokenExpiresAt,
            scopes: input.credentials.scopes,
            apiVersion: input.apiVersion,
            installedAt: now,
            uninstalledAt: null,
            nextReconciliationAt: now,
            reconciliationClaimedAt: null,
          },
        });

        await tx.externalPayload.create({
          data: {
            provider: 'SHOPIFY',
            resourceType: 'Shop',
            externalId: input.profile.id,
            apiVersion: input.apiVersion,
            payload: input.profile as unknown as Prisma.InputJsonValue,
          },
        });
      }

      // Deliberately do not link a Shopify staff member to a legacy Stride account by email. That
      // could inherit stale OWNER/ADMIN permissions. The synthetic address exists only because the
      // compatibility User table still requires a unique email during this migration.
      const internalEmail = syntheticIdentityEmail(input.shop, input.shopifyUserId);
      let user = await tx.user.findUnique({
        where: { email: internalEmail },
        select: { id: true },
      });
      if (!user) {
        user = await tx.user.create({
          data: {
            email: internalEmail,
            name: null,
            emailVerifiedAt: null,
          },
          select: { id: true },
        });
      }

      const role = authoritativeRole(input.associatedUser.account_owner);
      await tx.storeMembership.upsert({
        where: { userId_storeId: { userId: user.id, storeId: store.id } },
        create: { userId: user.id, storeId: store.id, role },
        update: { role },
      });

      await tx.shopifyUserIdentity.upsert({
        where: {
          storeId_shopifyUserId: {
            storeId: store.id,
            shopifyUserId: input.shopifyUserId,
          },
        },
        create: {
          storeId: store.id,
          userId: user.id,
          shopifyUserId: input.shopifyUserId,
          accountOwner: input.associatedUser.account_owner,
          collaborator: input.associatedUser.collaborator,
          emailVerified: input.associatedUser.email_verified,
          lastSeenAt: new Date(),
        },
        update: {
          userId: user.id,
          accountOwner: input.associatedUser.account_owner,
          collaborator: input.associatedUser.collaborator,
          emailVerified: input.associatedUser.email_verified,
          lastSeenAt: new Date(),
        },
      });

      return {
        storeId: store.id,
        userId: user.id,
        role,
      };
    });
  }
}

export const shopifyEmbeddedAuthRepository = new ShopifyEmbeddedAuthRepository();
