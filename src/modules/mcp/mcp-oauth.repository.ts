import { prisma } from '../../lib/prisma.js';

export class McpOAuthRepository {
  findRegisteredClient(clientId: string) {
    return prisma.mcpOAuthClient.findUnique({ where: { clientId } });
  }

  createRegisteredClient(input: { clientId: string; clientName: string; redirectUris: string[] }) {
    return prisma.mcpOAuthClient.create({ data: input });
  }

  createAuthorizationRequest(input: {
    clientId: string;
    clientName: string;
    redirectUri: string;
    state: string | null;
    scopes: string[];
    resource: string;
    codeChallenge: string;
    expiresAt: Date;
  }) {
    return prisma.mcpAuthorizationRequest.create({ data: input });
  }

  getAuthorizationRequest(id: string) {
    return prisma.mcpAuthorizationRequest.findUnique({ where: { id } });
  }

  deleteAuthorizationRequest(id: string) {
    return prisma.mcpAuthorizationRequest.deleteMany({ where: { id } });
  }

  listUserStores(userId: string) {
    return prisma.storeMembership.findMany({
      where: { userId },
      orderBy: { createdAt: 'asc' },
      select: {
        role: true,
        store: {
          select: {
            id: true,
            name: true,
            myshopifyDomain: true,
            currencyCode: true,
          },
        },
      },
    });
  }

  hasStoreAccess(userId: string, storeId: string) {
    return prisma.storeMembership.findUnique({
      where: { userId_storeId: { userId, storeId } },
      select: { role: true },
    });
  }

  createAuthorizationCode(input: {
    codeHash: string;
    userId: string;
    storeId: string;
    clientId: string;
    redirectUri: string;
    scopes: string[];
    resource: string;
    codeChallenge: string;
    expiresAt: Date;
  }) {
    return prisma.mcpAuthorizationCode.create({ data: input });
  }

  async consumeAuthorizationCode(codeHash: string) {
    const row = await prisma.mcpAuthorizationCode.findUnique({ where: { codeHash } });
    if (!row || row.usedAt || row.expiresAt <= new Date()) return null;
    const usedAt = new Date();
    const claimed = await prisma.mcpAuthorizationCode.updateMany({
      where: { id: row.id, usedAt: null, expiresAt: { gt: usedAt } },
      data: { usedAt },
    });
    return claimed.count === 1 ? row : null;
  }

  createRefreshToken(input: {
    tokenHash: string;
    userId: string;
    storeId: string;
    clientId: string;
    scopes: string[];
    resource: string;
    expiresAt: Date;
  }) {
    return prisma.mcpRefreshToken.create({ data: input });
  }

  findRefreshToken(tokenHash: string) {
    return prisma.mcpRefreshToken.findUnique({ where: { tokenHash } });
  }

  async rotateRefreshToken(input: {
    currentId: string;
    tokenHash: string;
    userId: string;
    storeId: string;
    clientId: string;
    scopes: string[];
    resource: string;
    expiresAt: Date;
  }) {
    const now = new Date();
    return prisma.$transaction(async (tx) => {
      const revoked = await tx.mcpRefreshToken.updateMany({
        where: {
          id: input.currentId,
          revokedAt: null,
          expiresAt: { gt: now },
        },
        data: { revokedAt: now },
      });
      if (revoked.count !== 1) return null;
      return tx.mcpRefreshToken.create({
        data: {
          tokenHash: input.tokenHash,
          userId: input.userId,
          storeId: input.storeId,
          clientId: input.clientId,
          scopes: input.scopes,
          resource: input.resource,
          expiresAt: input.expiresAt,
        },
      });
    });
  }
}

export const mcpOAuthRepository = new McpOAuthRepository();
