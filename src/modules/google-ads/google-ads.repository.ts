import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import { advertisingWriteRepository } from '../advertising/advertising-write.repository.js';

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

export class GoogleAdsRepository {
  findMembership(userId: string, storeId: string) {
    return prisma.storeMembership.findUnique({ where: { userId_storeId: { userId, storeId } }, select: { role: true } });
  }

  upsertConnection(input: {
    storeId: string;
    accessTokenCiphertext: string;
    accessTokenExpiresAt: Date;
    refreshTokenCiphertext: string;
    scopes: string[];
    apiVersion: string;
  }) {
    return prisma.$transaction(async (tx) => {
      const connection = await tx.googleAdsConnection.upsert({
        where: { storeId: input.storeId },
        create: { ...input, status: 'ACTIVE', selectedCustomerIds: [] },
        update: {
          status: 'ACTIVE',
          selectedCustomerIds: [],
          accessTokenCiphertext: input.accessTokenCiphertext,
          accessTokenExpiresAt: input.accessTokenExpiresAt,
          refreshTokenCiphertext: input.refreshTokenCiphertext,
          scopes: input.scopes,
          apiVersion: input.apiVersion,
          lastSyncStatus: null,
          lastSyncError: null,
        },
        select: { id: true, storeId: true, status: true, scopes: true, apiVersion: true },
      });

      // A successful OAuth exchange is a fresh authorization boundary. Provider-native discovery
      // and resume state from the previous credentials cannot authorize the new identity.
      await tx.googleAdsSyncCheckpoint.deleteMany({
        where: { googleAdsConnectionId: connection.id },
      });
      await tx.googleAdsCustomer.deleteMany({
        where: { storeId: input.storeId },
      });

      // Canonical Advertising* facts intentionally remain untouched. They are historical evidence,
      // but they are no longer merchant-selected until the current credentials rediscover/reselect.
      return connection;
    });
  }

  findConnectionForStore(storeId: string) {
    return prisma.googleAdsConnection.findUnique({ where: { storeId } });
  }

  updateAccessToken(id: string, accessTokenCiphertext: string, accessTokenExpiresAt: Date) {
    return prisma.googleAdsConnection.update({ where: { id }, data: { accessTokenCiphertext, accessTokenExpiresAt, status: 'ACTIVE' } });
  }

  markReauthRequired(id: string) {
    return prisma.googleAdsConnection.update({ where: { id }, data: { status: 'REAUTH_REQUIRED' } });
  }

  disconnect(storeId: string) {
    return prisma.googleAdsConnection.update({
      where: { storeId },
      data: { status: 'DISCONNECTED', selectedCustomerIds: [], accessTokenCiphertext: '', refreshTokenCiphertext: '', accessTokenExpiresAt: null },
    });
  }

  configureCustomers(connectionId: string, selectedCustomerIds: string[]) {
    return prisma.googleAdsConnection.update({ where: { id: connectionId }, data: { selectedCustomerIds } });
  }

  async upsertDiscoveredCustomer(input: {
    storeId: string;
    connectionId: string;
    customerId: string;
    loginCustomerId: string | null;
    descriptiveName: string;
    status: string | null;
    currencyCode: string | null;
    timeZone: string | null;
    manager: boolean;
    testAccount: boolean;
    level: number | null;
    parentCustomerId: string | null;
    raw: unknown;
  }) {
    const loginCustomerId = input.loginCustomerId ?? input.parentCustomerId;
    return prisma.$transaction(async (tx) => {
      const existingStaging = await tx.googleAdsCustomer.findUnique({
        where: { storeId_customerId: { storeId: input.storeId, customerId: input.customerId } },
        select: { id: true },
      });
      const historicalAccount = existingStaging
        ? null
        : await tx.advertisingAccount.findUnique({
            where: {
              storeId_provider_providerEntityId: {
                storeId: input.storeId,
                provider: 'GOOGLE_ADS',
                providerEntityId: input.customerId,
              },
            },
            select: { id: true },
          });
      const customer = await tx.googleAdsCustomer.upsert({
        where: { storeId_customerId: { storeId: input.storeId, customerId: input.customerId } },
        create: {
          ...(historicalAccount ? { id: historicalAccount.id } : {}),
          storeId: input.storeId, googleAdsConnectionId: input.connectionId, customerId: input.customerId,
          loginCustomerId, descriptiveName: input.descriptiveName, status: input.status,
          currencyCode: input.currencyCode, timeZone: input.timeZone, manager: input.manager,
          testAccount: input.testAccount, level: input.level, parentCustomerId: input.parentCustomerId,
          rawJson: json(input.raw), lastDiscoveredAt: new Date(),
        },
        update: {
          googleAdsConnectionId: input.connectionId, loginCustomerId,
          descriptiveName: input.descriptiveName, status: input.status, currencyCode: input.currencyCode,
          timeZone: input.timeZone, manager: input.manager, testAccount: input.testAccount,
          level: input.level, parentCustomerId: input.parentCustomerId, rawJson: json(input.raw), lastDiscoveredAt: new Date(),
        },
      });
      await advertisingWriteRepository.upsertAccount(tx, {
        id: customer.id, storeId: input.storeId, provider: 'GOOGLE_ADS', providerEntityId: input.customerId,
        name: input.descriptiveName, status: input.status, currency: input.currencyCode, timezone: input.timeZone,
        providerData: { manager: input.manager, testAccount: input.testAccount, loginCustomerId, level: input.level, parentCustomerId: input.parentCustomerId },
        rawJson: input.raw, lastSyncedAt: null, createdAt: customer.createdAt, updatedAt: customer.updatedAt,
      });
      return customer;
    });
  }

  pruneDiscoveredCustomers(storeId: string, connectionId: string, currentCustomerIds: string[]) {
    return prisma.googleAdsCustomer.deleteMany({
      where: {
        storeId,
        googleAdsConnectionId: connectionId,
        ...(currentCustomerIds.length > 0
          ? { customerId: { notIn: currentCustomerIds } }
          : {}),
      },
    });
  }

  listCustomers(storeId: string) {
    return prisma.googleAdsCustomer.findMany({ where: { storeId }, orderBy: [{ manager: 'desc' }, { descriptiveName: 'asc' }, { customerId: 'asc' }] });
  }

  findSelectedCustomers(storeId: string, customerIds: string[]) {
    if (customerIds.length === 0) return Promise.resolve([]);
    return prisma.googleAdsCustomer.findMany({ where: { storeId, customerId: { in: customerIds } } });
  }

  listSyncCheckpoints(connectionId: string, customerId: string, kindPrefix = 'METRICS_') {
    return prisma.googleAdsSyncCheckpoint.findMany({
      where: {
        googleAdsConnectionId: connectionId,
        customerId,
        kind: { startsWith: kindPrefix },
      },
      select: { kind: true, windowStart: true, windowEnd: true },
    });
  }

  markSyncCheckpoint(input: {
    connectionId: string;
    customerId: string;
    kind: string;
    windowStart: Date;
    windowEnd: Date;
  }) {
    return prisma.googleAdsSyncCheckpoint.upsert({
      where: {
        googleAdsConnectionId_customerId_kind_windowStart_windowEnd: {
          googleAdsConnectionId: input.connectionId,
          customerId: input.customerId,
          kind: input.kind,
          windowStart: input.windowStart,
          windowEnd: input.windowEnd,
        },
      },
      create: {
        googleAdsConnectionId: input.connectionId,
        customerId: input.customerId,
        kind: input.kind,
        windowStart: input.windowStart,
        windowEnd: input.windowEnd,
      },
      update: { completedAt: new Date() },
    });
  }

  clearSyncCheckpoints(connectionId: string, kindPrefix = 'METRICS_') {
    return prisma.googleAdsSyncCheckpoint.deleteMany({
      where: { googleAdsConnectionId: connectionId, kind: { startsWith: kindPrefix } },
    });
  }

  markSyncResult(connectionId: string, input: { status: 'SUCCEEDED' | 'PARTIAL' | 'FAILED'; error?: string | null }) {
    return prisma.googleAdsConnection.update({
      where: { id: connectionId },
      data: {
        ...(input.status === 'SUCCEEDED' ? { lastSyncedAt: new Date() } : {}),
        lastSyncStatus: input.status,
        lastSyncError: input.error ?? null,
      },
    });
  }
}
