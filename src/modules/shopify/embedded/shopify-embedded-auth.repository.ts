import { createHash } from 'node:crypto';
import { Prisma } from '../../../generated/prisma/client.js';
import { prisma } from '../../../lib/prisma.js';
import { AppError } from '../../../errors/app-error.js';
import type { ShopifyShopProfile } from '../shopify.schema.js';
import type { ShopifyAssociatedUser } from './shopify-embedded.schema.js';

export type EmbeddedOfflineCredentials = {
  accessTokenCiphertext: string;
  accessTokenExpiresAt: Date;
  refreshTokenCiphertext: string;
  refreshTokenExpiresAt: Date;
  scopes: string[];
  verifiedAt?: Date;
  installationId?: string;
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
    // Retry unique-key races only after the losing transaction has rolled back.
    for (let attempt = 0; ; attempt += 1) {
      try {
        return await this.provisionTransaction(input);
      } catch (error) {
        if (
          !(error instanceof Prisma.PrismaClientKnownRequestError) ||
          error.code !== 'P2002' ||
          attempt >= 2
        )
          throw error;
      }
    }
  }

  private provisionTransaction(input: {
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
          OR: [{ shopifyShopId: input.profile.id }, { myshopifyDomain: input.shop }],
        },
        select: { id: true, shopifyConnection: { select: { status: true } } },
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
        const now = input.credentials.verifiedAt ?? new Date();
        const previous = await tx.shopifyConnection.findUnique({
          where: { storeId: store.id },
          select: {
            status: true,
            installedAt: true,
            uninstalledAt: true,
            installationVerifiedAt: true,
            shopifyAppInstallationId: true,
          },
        });
        if (previous?.installationVerifiedAt && previous.installationVerifiedAt > now) {
          throw new AppError(
            'A newer Shopify installation verification has completed',
            409,
            'SHOPIFY_INSTALLATION_SUPERSEDED',
          );
        }
        if (previous?.uninstalledAt && previous.uninstalledAt >= now) {
          throw new AppError(
            'Shopify was uninstalled after this installation verification began',
            401,
            'SHOPIFY_INSTALLATION_REVOKED',
          );
        }
        const installationChanged =
          !previous ||
          previous.status !== 'ACTIVE' ||
          !input.credentials.installationId ||
          previous.shopifyAppInstallationId !== input.credentials.installationId;
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
            installedAt: now,
            installationVerifiedAt: now,
            shopifyAppInstallationId: input.credentials.installationId ?? null,
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
            installedAt: installationChanged ? now : (previous?.installedAt ?? now),
            installationVerifiedAt: now,
            shopifyAppInstallationId: input.credentials.installationId ?? null,
            uninstalledAt: null,
            nextReconciliationAt: now,
            reconciliationClaimedAt: null,
          },
        });

        // Fresh credentials are the installation proof; a prior ACTIVE flag cannot prove
        // continuity when uninstall delivery is asynchronous. Never carry its paid grant over.
        if (candidates[0] && installationChanged) {
          await tx.storeSubscription.updateMany({
            where: { storeId: store.id, provider: 'SHOPIFY' },
            data: {
              status: 'EXPIRED',
              trialEndsAt: now,
              currentPeriodEndsAt: null,
              lastVerifiedAt: null,
              canceledAt: null,
              cancelAtEndOfCycle: false,
              shopifyAppSubscriptionId: null,
              shopifyPlanHandle: null,
            },
          });
          await tx.mcpRefreshToken.updateMany({
            where: { storeId: store.id, revokedAt: null },
            data: { revokedAt: now },
          });
          await tx.mcpAuthorizationCode.deleteMany({ where: { storeId: store.id } });
          await tx.conversionDestination.updateMany({
            where: { storeId: store.id },
            data: { status: 'DISABLED' },
          });
          await tx.pixelInstallation.updateMany({
            where: { storeId: store.id },
            data: { status: 'DISABLED', shopifyWebPixelId: null },
          });
        }

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
