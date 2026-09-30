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

function normalizedVerifiedEmail(user: ShopifyAssociatedUser): string | null {
  if (!user.email_verified) return null;
  const email = user.email.trim().toLowerCase();
  return email || null;
}

function syntheticIdentityEmail(shop: string, shopifyUserId: string): string {
  const digest = createHash('sha256')
    .update(`${shop}\u0000${shopifyUserId}`)
    .digest('hex')
    .slice(0, 32);
  return `shopify-${digest}@identity.invalid`;
}

function displayName(user: ShopifyAssociatedUser): string | null {
  const value = `${user.first_name} ${user.last_name}`.trim();
  return value || null;
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
        user: {
          select: {
            memberships: {
              where: { storeId },
              select: { role: true },
              take: 1,
            },
          },
        },
      },
    });
    if (!identity?.user.memberships[0]) return null;

    await prisma.shopifyUserIdentity.update({
      where: { storeId_shopifyUserId: { storeId, shopifyUserId } },
      data: { lastSeenAt: new Date() },
    });

    return {
      userId: identity.userId,
      role: identity.user.memberships[0].role,
      accountOwner: identity.accountOwner,
      collaborator: identity.collaborator,
    };
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
        select: { id: true, shopifyShopId: true, myshopifyDomain: true },
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

      const verifiedEmail = normalizedVerifiedEmail(input.associatedUser);
      const internalEmail =
        verifiedEmail ?? syntheticIdentityEmail(input.shop, input.shopifyUserId);
      let user = await tx.user.findUnique({
        where: { email: internalEmail },
        select: { id: true },
      });
      if (!user) {
        user = await tx.user.create({
          data: {
            email: internalEmail,
            name: displayName(input.associatedUser),
            emailVerifiedAt: verifiedEmail ? new Date() : null,
          },
          select: { id: true },
        });
      }

      const existingMembership = await tx.storeMembership.findUnique({
        where: { userId_storeId: { userId: user.id, storeId: store.id } },
        select: { role: true },
      });
      if (!existingMembership) {
        await tx.storeMembership.create({
          data: {
            userId: user.id,
            storeId: store.id,
            role: input.associatedUser.account_owner ? 'OWNER' : 'MEMBER',
          },
        });
      } else if (input.associatedUser.account_owner && existingMembership.role !== 'OWNER') {
        await tx.storeMembership.update({
          where: { userId_storeId: { userId: user.id, storeId: store.id } },
          data: { role: 'OWNER' },
        });
      }

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

      const membership = await tx.storeMembership.findUniqueOrThrow({
        where: { userId_storeId: { userId: user.id, storeId: store.id } },
        select: { role: true },
      });

      return {
        storeId: store.id,
        userId: user.id,
        role: membership.role,
      };
    });
  }
}

export const shopifyEmbeddedAuthRepository = new ShopifyEmbeddedAuthRepository();
