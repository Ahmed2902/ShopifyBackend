import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import type {
  ShopifyInventoryLevel,
  ShopifyLocation,
  ShopifyProduct,
  ShopifyShopProfile,
  ShopifyVariant,
} from './shopify.schema.js';

interface ShopifyTokenSet {
  accessTokenCiphertext: string;
  accessTokenExpiresAt: Date;
  refreshTokenCiphertext: string;
  refreshTokenExpiresAt: Date;
  scopes: string[];
}

interface InventoryQuantityState {
  available: number;
  incoming: number;
  committed: number;
  onHand: number;
  reserved: number;
  damaged: number;
  safetyStock: number;
  qualityControl: number;
}

function optionalDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}

function inventoryState(level: ShopifyInventoryLevel): InventoryQuantityState {
  const quantities = new Map(level.quantities.map((entry) => [entry.name, entry.quantity]));
  return {
    available: quantities.get('available') ?? 0,
    incoming: quantities.get('incoming') ?? 0,
    committed: quantities.get('committed') ?? 0,
    onHand: quantities.get('on_hand') ?? 0,
    reserved: quantities.get('reserved') ?? 0,
    damaged: quantities.get('damaged') ?? 0,
    safetyStock: quantities.get('safety_stock') ?? 0,
    qualityControl: quantities.get('quality_control') ?? 0,
  };
}

export class ShopifyRepository {
  async connectStore(input: {
    userId: string;
    profile: ShopifyShopProfile;
    canonicalDomain: string;
    credentials: ShopifyTokenSet;
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
          accessTokenCiphertext: input.credentials.accessTokenCiphertext,
          accessTokenExpiresAt: input.credentials.accessTokenExpiresAt,
          refreshTokenCiphertext: input.credentials.refreshTokenCiphertext,
          refreshTokenExpiresAt: input.credentials.refreshTokenExpiresAt,
          scopes: input.credentials.scopes,
          apiVersion: input.apiVersion,
        },
        update: {
          status: 'ACTIVE',
          accessTokenCiphertext: input.credentials.accessTokenCiphertext,
          accessTokenExpiresAt: input.credentials.accessTokenExpiresAt,
          refreshTokenCiphertext: input.credentials.refreshTokenCiphertext,
          refreshTokenExpiresAt: input.credentials.refreshTokenExpiresAt,
          scopes: input.credentials.scopes,
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
            accessTokenExpiresAt: true,
            refreshTokenCiphertext: true,
            refreshTokenExpiresAt: true,
            scopes: true,
            apiVersion: true,
            lastSyncedAt: true,
          },
        },
      },
    });
  }

  updateConnectionTokens(connectionId: string, credentials: ShopifyTokenSet) {
    return prisma.shopifyConnection.update({
      where: { id: connectionId },
      data: {
        status: 'ACTIVE',
        accessTokenCiphertext: credentials.accessTokenCiphertext,
        accessTokenExpiresAt: credentials.accessTokenExpiresAt,
        refreshTokenCiphertext: credentials.refreshTokenCiphertext,
        refreshTokenExpiresAt: credentials.refreshTokenExpiresAt,
        scopes: credentials.scopes,
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

  upsertProduct(storeId: string, product: ShopifyProduct) {
    const data = {
      title: product.title,
      handle: product.handle ?? null,
      productType: product.productType ?? null,
      vendor: product.vendor ?? null,
      tags: product.tags,
      status: product.status,
      totalInventory: product.totalInventory ?? null,
      tracksInventory: product.tracksInventory,
      publishedAt: optionalDate(product.publishedAt),
      shopifyCreatedAt: optionalDate(product.createdAt),
      shopifyUpdatedAt: optionalDate(product.updatedAt),
      deletedAt: null,
      rawJson: product as unknown as Prisma.InputJsonValue,
    };

    return prisma.product.upsert({
      where: { storeId_shopifyProductId: { storeId, shopifyProductId: product.id } },
      create: { storeId, shopifyProductId: product.id, ...data },
      update: data,
    });
  }

  async upsertVariant(storeId: string, variant: ShopifyVariant): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const product = await tx.product.findUnique({
        where: {
          storeId_shopifyProductId: {
            storeId,
            shopifyProductId: variant.product.id,
          },
        },
        select: { id: true },
      });
      if (!product) return false;

      const data = {
        productId: product.id,
        title: variant.title,
        displayName: variant.displayName ?? null,
        sku: variant.sku ?? null,
        barcode: variant.barcode ?? null,
        price: variant.price ?? null,
        compareAtPrice: variant.compareAtPrice ?? null,
        position: variant.position ?? null,
        availableForSale: variant.availableForSale,
        inventoryQuantity: variant.inventoryQuantity ?? null,
        inventoryPolicy: variant.inventoryPolicy ?? null,
        shopifyCreatedAt: optionalDate(variant.createdAt),
        shopifyUpdatedAt: optionalDate(variant.updatedAt),
        deletedAt: null,
        rawJson: variant as unknown as Prisma.InputJsonValue,
      };

      const savedVariant = await tx.productVariant.upsert({
        where: { storeId_shopifyVariantId: { storeId, shopifyVariantId: variant.id } },
        create: { storeId, shopifyVariantId: variant.id, ...data },
        update: data,
        select: { id: true },
      });

      await tx.variantOption.deleteMany({ where: { variantId: savedVariant.id } });
      if (variant.selectedOptions.length > 0) {
        await tx.variantOption.createMany({
          data: variant.selectedOptions.map((option, index) => ({
            variantId: savedVariant.id,
            name: option.name,
            value: option.value,
            position: index + 1,
          })),
        });
      }

      const inventoryItem = variant.inventoryItem;
      const inventoryData = {
        sku: inventoryItem.sku ?? variant.sku ?? null,
        tracked: inventoryItem.tracked,
        requiresShipping: inventoryItem.requiresShipping,
        shopifyCreatedAt: optionalDate(inventoryItem.createdAt),
        shopifyUpdatedAt: optionalDate(inventoryItem.updatedAt),
        deletedAt: null,
        rawJson: inventoryItem as unknown as Prisma.InputJsonValue,
      };

      await tx.inventoryItem.upsert({
        where: { variantId: savedVariant.id },
        create: {
          storeId,
          variantId: savedVariant.id,
          shopifyInventoryItemId: inventoryItem.id,
          ...inventoryData,
        },
        update: {
          shopifyInventoryItemId: inventoryItem.id,
          ...inventoryData,
        },
      });

      return true;
    });
  }

  upsertLocation(storeId: string, location: ShopifyLocation) {
    const data = {
      name: location.name,
      isActive: location.isActive,
      fulfillsOnlineOrders: location.fulfillsOnlineOrders ?? null,
      shipsInventory: location.shipsInventory ?? null,
      hasActiveInventory: location.hasActiveInventory ?? null,
      deactivatedAt: optionalDate(location.deactivatedAt),
      addressJson: location.address
        ? (location.address as unknown as Prisma.InputJsonValue)
        : undefined,
      shopifyCreatedAt: optionalDate(location.createdAt),
      shopifyUpdatedAt: optionalDate(location.updatedAt),
      deletedAt: null,
      rawJson: location as unknown as Prisma.InputJsonValue,
    };

    return prisma.location.upsert({
      where: { storeId_shopifyLocationId: { storeId, shopifyLocationId: location.id } },
      create: { storeId, shopifyLocationId: location.id, ...data },
      update: data,
    });
  }

  async upsertInventoryLevel(
    storeId: string,
    level: ShopifyInventoryLevel,
    source: 'INITIAL_SYNC' | 'MANUAL_RECONCILIATION',
  ): Promise<boolean> {
    return prisma.$transaction(async (tx) => {
      const [item, location] = await Promise.all([
        tx.inventoryItem.findUnique({
          where: {
            storeId_shopifyInventoryItemId: {
              storeId,
              shopifyInventoryItemId: level.item.id,
            },
          },
          select: { id: true },
        }),
        tx.location.findUnique({
          where: {
            storeId_shopifyLocationId: {
              storeId,
              shopifyLocationId: level.location.id,
            },
          },
          select: { id: true },
        }),
      ]);

      if (!item || !location) return false;

      const quantities = inventoryState(level);
      const observedAt = optionalDate(level.updatedAt) ?? new Date();
      const reconciledAt = new Date();

      await tx.inventoryLevelCurrent.upsert({
        where: {
          inventoryItemId_locationId: {
            inventoryItemId: item.id,
            locationId: location.id,
          },
        },
        create: {
          inventoryItemId: item.id,
          locationId: location.id,
          ...quantities,
          sourceUpdatedAt: optionalDate(level.updatedAt),
          lastReconciledAt: reconciledAt,
        },
        update: {
          ...quantities,
          sourceUpdatedAt: optionalDate(level.updatedAt),
          lastReconciledAt: reconciledAt,
        },
      });

      await tx.inventorySnapshot.create({
        data: {
          inventoryItemId: item.id,
          locationId: location.id,
          ...quantities,
          observedAt,
          source,
        },
      });

      return true;
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
