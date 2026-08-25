import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';

const json = (value: unknown): Prisma.InputJsonValue => value as Prisma.InputJsonValue;

export class TikTokRepository {
  findMembership(userId: string, storeId: string) {
    return prisma.storeMembership.findUnique({
      where: { userId_storeId: { userId, storeId } },
      select: { role: true },
    });
  }

  upsertConnection(input: {
    storeId: string;
    accessTokenCiphertext: string;
    scopes: string[];
    apiVersion: string;
  }) {
    return prisma.tikTokConnection.upsert({
      where: { storeId: input.storeId },
      create: {
        storeId: input.storeId,
        status: 'ACTIVE',
        accessTokenCiphertext: input.accessTokenCiphertext,
        scopes: input.scopes,
        apiVersion: input.apiVersion,
      },
      update: {
        status: 'ACTIVE',
        accessTokenCiphertext: input.accessTokenCiphertext,
        accessTokenExpiresAt: null,
        refreshTokenCiphertext: null,
        refreshTokenExpiresAt: null,
        scopes: input.scopes,
        apiVersion: input.apiVersion,
      },
      select: { id: true, storeId: true, status: true, scopes: true },
    });
  }

  findConnectionForStore(storeId: string) {
    return prisma.tikTokConnection.findUnique({
      where: { storeId },
      select: {
        id: true,
        storeId: true,
        status: true,
        openId: true,
        businessCenterId: true,
        selectedAdvertiserIds: true,
        selectedCatalogIds: true,
        accessTokenCiphertext: true,
        accessTokenExpiresAt: true,
        refreshTokenCiphertext: true,
        refreshTokenExpiresAt: true,
        scopes: true,
        apiVersion: true,
        lastSyncedAt: true,
      },
    });
  }

  markConnectionReauthRequired(id: string) {
    return prisma.tikTokConnection.update({ where: { id }, data: { status: 'REAUTH_REQUIRED' } });
  }

  configureAssets(connectionId: string, businessCenterId: string | null, advertiserIds: string[]) {
    return prisma.tikTokConnection.update({
      where: { id: connectionId },
      data: { businessCenterId, selectedAdvertiserIds: advertiserIds },
    });
  }

  configureCatalogs(connectionId: string, catalogIds: string[]) {
    return prisma.tikTokConnection.update({
      where: { id: connectionId },
      data: { selectedCatalogIds: catalogIds },
    });
  }

  markConnectionSynced(connectionId: string) {
    return prisma.tikTokConnection.update({
      where: { id: connectionId },
      data: { lastSyncedAt: new Date() },
    });
  }

  upsertAdvertiser(input: {
    storeId: string;
    connectionId: string;
    advertiserId: string;
    name: string;
    status?: string | null;
    currency?: string | null;
    timezone?: string | null;
    countryCode?: string | null;
    industry?: string | null;
    company?: string | null;
    balance?: string | number | null;
    raw: unknown;
  }) {
    const data = {
      tiktokConnectionId: input.connectionId,
      name: input.name,
      status: input.status,
      currency: input.currency,
      timezone: input.timezone,
      countryCode: input.countryCode,
      industry: input.industry,
      company: input.company,
      balance: input.balance,
      lastSyncedAt: new Date(),
      rawJson: json(input.raw),
    };
    return prisma.tikTokAdvertiser.upsert({
      where: { storeId_advertiserId: { storeId: input.storeId, advertiserId: input.advertiserId } },
      create: { storeId: input.storeId, advertiserId: input.advertiserId, ...data },
      update: data,
    });
  }
}
