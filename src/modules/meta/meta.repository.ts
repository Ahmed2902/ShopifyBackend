import type { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../lib/prisma.js';
import type { MetaAdAccountAsset } from './meta.types.js';

const adAccountSelect = {
  id: true,
  metaAccountId: true,
  name: true,
  status: true,
  currency: true,
  timezoneName: true,
  lastSyncedAt: true,
} satisfies Prisma.MetaAdAccountSelect;

const connectionSelect = {
  id: true,
  storeId: true,
  status: true,
  metaUserId: true,
  metaBusinessId: true,
  selectedAdAccountIds: true,
  selectedCatalogIds: true,
  tokenExpiresAt: true,
  scopes: true,
  apiVersion: true,
  lastSyncedAt: true,
  adAccounts: { select: adAccountSelect },
} satisfies Prisma.MetaConnectionSelect;

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
    const data = {
      status: 'ACTIVE' as const,
      metaUserId: input.metaUserId,
      accessTokenCiphertext: input.accessTokenCiphertext,
      tokenExpiresAt: input.tokenExpiresAt,
      scopes: input.scopes,
      apiVersion: input.apiVersion,
    };
    return prisma.metaConnection.upsert({
      where: { storeId: input.storeId },
      create: { storeId: input.storeId, ...data },
      update: data,
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
      select: { ...connectionSelect, accessTokenCiphertext: true },
    });
  }

  markConnectionReauthRequired(connectionId: string) {
    return prisma.metaConnection.update({
      where: { id: connectionId },
      data: { status: 'REAUTH_REQUIRED' },
    });
  }

  async markConnectionSynced(connectionId: string, syncedAt = new Date()) {
    return prisma.$transaction(async (tx) => {
      const connection = await tx.metaConnection.update({
        where: { id: connectionId },
        data: { lastSyncedAt: syncedAt },
      });

      // Meta hierarchy sync can turn a previously unresolved Pixel touch into an exact identity,
      // or invalidate/reparent a previously exact one. Rotate repair generations for every
      // retained browser session carrying Meta hierarchy IDs so session materialization resolves
      // against the newly synced hierarchy before behavior/attribution rollups are acknowledged.
      await tx.$executeRaw`
        INSERT INTO "StorefrontSessionRepair"
          ("id", "storeId", "browserSessionId", "sourceReceivedAt", "createdAt", "updatedAt")
        SELECT
          gen_random_uuid(),
          e."storeId",
          e."sessionId",
          MAX(e."receivedAt"),
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        FROM "StorefrontEvent" e
        WHERE e."storeId" = ${connection.storeId}::uuid
          AND e."sessionId" IS NOT NULL
          AND (
            e."metaCampaignExternalId" IS NOT NULL
            OR e."metaAdSetExternalId" IS NOT NULL
            OR e."metaAdExternalId" IS NOT NULL
          )
        GROUP BY e."storeId", e."sessionId"
        ON CONFLICT ("storeId", "browserSessionId")
        DO UPDATE SET
          "id" = EXCLUDED."id",
          "sourceReceivedAt" = GREATEST(
            "StorefrontSessionRepair"."sourceReceivedAt",
            EXCLUDED."sourceReceivedAt"
          ),
          "updatedAt" = CURRENT_TIMESTAMP
      `;

      return connection;
    });
  }

  async configureAssets(input: {
    connectionId: string;
    storeId: string;
    metaBusinessId: string | null;
    adAccounts: MetaAdAccountAsset[];
  }) {
    return prisma.$transaction(async (tx) => {
      const connection = await tx.metaConnection.update({
        where: { id: input.connectionId },
        data: {
          metaBusinessId: input.metaBusinessId,
          selectedAdAccountIds: input.adAccounts.map((account) => account.id),
        },
      });

      for (const account of input.adAccounts) {
        const data = {
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
        };
        await tx.metaAdAccount.upsert({
          where: {
            storeId_metaAccountId: {
              storeId: input.storeId,
              metaAccountId: account.id,
            },
          },
          create: {
            storeId: input.storeId,
            metaAccountId: account.id,
            ...data,
          },
          update: data,
        });
      }

      return connection;
    });
  }

  getStatus(storeId: string) {
    return prisma.metaConnection.findUnique({ where: { storeId }, select: connectionSelect });
  }
}
