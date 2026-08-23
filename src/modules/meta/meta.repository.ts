import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import type { MetaAdAccountAsset } from './meta.types.js';

export class MetaRepository {
  findMembership(userId: string, storeId: string) {
    return prisma.storeMembership.findUnique({
      where: { userId_storeId: { userId, storeId } },
      select: { role: true },
    });
  }

  upsertConnection(input: {
    storeId: string;
    metaUserId: string;
    accessTokenCiphertext: string;
    tokenExpiresAt: Date | null;
    scopes: string[];
    apiVersion: string;
  }) {
    return prisma.metaConnection.upsert({
      where: { storeId: input.storeId },
      create: {
        storeId: input.storeId,
        status: 'ACTIVE',
        metaUserId: input.metaUserId,
        accessTokenCiphertext: input.accessTokenCiphertext,
        tokenExpiresAt: input.tokenExpiresAt,
        scopes: input.scopes,
        apiVersion: input.apiVersion,
      },
      update: {
        status: 'ACTIVE',
        metaUserId: input.metaUserId,
        accessTokenCiphertext: input.accessTokenCiphertext,
        tokenExpiresAt: input.tokenExpiresAt,
        scopes: input.scopes,
        apiVersion: input.apiVersion,
      },
      select: {
        id: true,
        storeId: true,
        metaUserId: true,
        metaBusinessId: true,
        selectedAdAccountIds: true,
        selectedCatalogIds: true,
        scopes: true,
        apiVersion: true,
        tokenExpiresAt: true,
      },
    });
  }

  findConnectionForStore(storeId: string) {
    return prisma.metaConnection.findUnique({
      where: { storeId },
      select: {
        id: true,
        storeId: true,
        status: true,
        metaUserId: true,
        metaBusinessId: true,
        selectedAdAccountIds: true,
        selectedCatalogIds: true,
        accessTokenCiphertext: true,
        tokenExpiresAt: true,
        scopes: true,
        apiVersion: true,
        lastSyncedAt: true,
        adAccounts: {
          select: {
            id: true,
            metaAccountId: true,
            name: true,
            status: true,
            currency: true,
            timezoneName: true,
            lastSyncedAt: true,
          },
        },
      },
    });
  }

  markConnectionReauthRequired(connectionId: string) {
    return prisma.metaConnection.update({
      where: { id: connectionId },
      data: { status: 'REAUTH_REQUIRED' },
    });
  }

  markConnectionSynced(connectionId: string, syncedAt = new Date()) {
    return prisma.metaConnection.update({
      where: { id: connectionId },
      data: { lastSyncedAt: syncedAt },
    });
  }

  async configureAssets(input: {
    connectionId: string;
    storeId: string;
    metaBusinessId: string | null;
    adAccounts: MetaAdAccountAsset[];
  }) {
    return prisma.$transaction(async (tx) => {
      const selectedIds = input.adAccounts.map((account) => account.id);
      const connection = await tx.metaConnection.update({
        where: { id: input.connectionId },
        data: {
          metaBusinessId: input.metaBusinessId,
          selectedAdAccountIds: selectedIds,
        },
      });

      for (const account of input.adAccounts) {
        await tx.metaAdAccount.upsert({
          where: {
            storeId_metaAccountId: {
              storeId: input.storeId,
              metaAccountId: account.id,
            },
          },
          create: {
            storeId: input.storeId,
            metaConnectionId: input.connectionId,
            metaAccountId: account.id,
            name: account.name,
            status: account.accountStatus === null ? null : String(account.accountStatus),
            currency: account.currency,
            timezoneName: account.timezoneName,
            timezoneId: account.timezoneId,
            timezoneOffsetHours: account.timezoneOffsetHoursUtc,
            amountSpentMinor: account.amountSpentMinor,
            balanceMinor: account.balanceMinor,
            spendCapMinor: account.spendCapMinor,
            rawJson: account.raw as Prisma.InputJsonValue,
          },
          update: {
            metaConnectionId: input.connectionId,
            name: account.name,
            status: account.accountStatus === null ? null : String(account.accountStatus),
            currency: account.currency,
            timezoneName: account.timezoneName,
            timezoneId: account.timezoneId,
            timezoneOffsetHours: account.timezoneOffsetHoursUtc,
            amountSpentMinor: account.amountSpentMinor,
            balanceMinor: account.balanceMinor,
            spendCapMinor: account.spendCapMinor,
            rawJson: account.raw as Prisma.InputJsonValue,
          },
        });
      }

      return connection;
    });
  }

  getStatus(storeId: string) {
    return prisma.metaConnection.findUnique({
      where: { storeId },
      select: {
        id: true,
        status: true,
        metaUserId: true,
        metaBusinessId: true,
        selectedAdAccountIds: true,
        selectedCatalogIds: true,
        tokenExpiresAt: true,
        scopes: true,
        apiVersion: true,
        lastSyncedAt: true,
        adAccounts: {
          select: {
            id: true,
            metaAccountId: true,
            name: true,
            status: true,
            currency: true,
            timezoneName: true,
            lastSyncedAt: true,
          },
        },
      },
    });
  }
}
