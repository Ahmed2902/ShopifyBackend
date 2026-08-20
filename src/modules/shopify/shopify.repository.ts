import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import type { ShopifyShopProfile } from './shopify.schema.js';

export class ShopifyRepository {
  async connectStore(input: {
    userId: string;
    profile: ShopifyShopProfile;
    canonicalDomain: string;
    encryptedToken: string;
    scopes: string[];
    apiVersion: string;
  }): Promise<{ id: string } | null> {
    return prisma.$transaction(async (tx) => {
      const existingStore = await tx.store.findFirst({
        where: {
          OR: [
            { shopifyShopId: input.profile.id },
            { myshopifyDomain: input.canonicalDomain },
          ],
        },
        select: {
          id: true,
          memberships: {
            where: { userId: input.userId },
            select: { id: true },
          },
        },
      });

      if (existingStore && existingStore.memberships.length === 0) return null;

      const storeData = {
        shopifyShopId: input.profile.id,
        name: input.profile.name,
        myshopifyDomain: input.canonicalDomain,
        currencyCode: input.profile.currencyCode,
        ianaTimezone: input.profile.ianaTimezone,
        primaryDomainHost: input.profile.primaryDomain?.host ?? null,
        primaryDomainUrl: input.profile.primaryDomain?.url ?? null,
        enabledPresentmentCurrencies: input.profile.enabledPresentmentCurrencies,
        shopifyCreatedAt: new Date(input.profile.createdAt),
      };

      const store = existingStore
        ? await tx.store.update({
            where: { id: existingStore.id },
            data: storeData,
            select: { id: true },
          })
        : await tx.store.create({
            data: {
              ...storeData,
              memberships: {
                create: { userId: input.userId, role: 'OWNER' },
              },
            },
            select: { id: true },
          });

      await tx.shopifyConnection.upsert({
        where: { storeId: store.id },
        create: {
          storeId: store.id,
          status: 'ACTIVE',
          accessTokenCiphertext: input.encryptedToken,
          scopes: input.scopes,
          apiVersion: input.apiVersion,
        },
        update: {
          status: 'ACTIVE',
          accessTokenCiphertext: input.encryptedToken,
          scopes: input.scopes,
          apiVersion: input.apiVersion,
          installedAt: new Date(),
          uninstalledAt: null,
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

      return store;
    });
  }

  findConnectionForSync(storeId: string) {
    return prisma.store.findUnique({
      where: { id: storeId },
      select: {
        id: true,
        myshopifyDomain: true,
        shopifyConnection: {
          select: {
            id: true,
            status: true,
            accessTokenCiphertext: true,
            apiVersion: true,
          },
        },
      },
    });
  }

  updateStoreProfile(storeId: string, profile: ShopifyShopProfile) {
    return prisma.store.update({
      where: { id: storeId },
      data: {
        shopifyShopId: profile.id,
        name: profile.name,
        myshopifyDomain: profile.myshopifyDomain,
        currencyCode: profile.currencyCode,
        ianaTimezone: profile.ianaTimezone,
        primaryDomainHost: profile.primaryDomain?.host ?? null,
        primaryDomainUrl: profile.primaryDomain?.url ?? null,
        enabledPresentmentCurrencies: profile.enabledPresentmentCurrencies,
        shopifyCreatedAt: new Date(profile.createdAt),
      },
    });
  }

  markConnectionSynced(connectionId: string) {
    return prisma.shopifyConnection.update({
      where: { id: connectionId },
      data: { status: 'ACTIVE', lastSyncedAt: new Date() },
    });
  }

  markConnectionReauthRequired(connectionId: string) {
    return prisma.shopifyConnection.update({
      where: { id: connectionId },
      data: { status: 'REAUTH_REQUIRED' },
    });
  }
}
