import { prisma } from '../../lib/prisma.js';
import { MCP_AUTHORIZATION_CODE_TTL_MS } from './mcp-oauth.utils.js';

export class McpOAuthRepository {
  findRegisteredClient(clientId: string) {
    return prisma.mcpOAuthClient.findUnique({ where: { clientId } });
  }

  createRegisteredClient(input: { clientId: string; clientName: string; redirectUris: string[] }) {
    return prisma.mcpOAuthClient.create({ data: input });
  }

  async createAuthorizationRequest(input: {
    clientId: string;
    clientName: string;
    redirectUri: string;
    state: string | null;
    scopes: string[];
    resource: string;
    codeChallenge: string;
    expiresAt: Date;
    returnTokenHash?: string;
  }) {
    // Results contain encrypted, short-lived codes. Remove expired handoffs when
    // a new connection starts, using the existing expiresAt index.
    await prisma.mcpAuthorizationRequest.deleteMany({ where: { expiresAt: { lte: new Date() } } });
    return prisma.mcpAuthorizationRequest.create({ data: input });
  }

  getAuthorizationRequest(id: string) {
    return prisma.mcpAuthorizationRequest.findUnique({ where: { id } });
  }

  deleteAuthorizationRequest(id: string) {
    return prisma.mcpAuthorizationRequest.deleteMany({ where: { id } });
  }

  async completeAuthorizationRequest(id: string, returnUrlCiphertext: string) {
    const now = new Date();
    return prisma.mcpAuthorizationRequest.updateMany({
      where: { id, decidedAt: null, expiresAt: { gt: now } },
      data: {
        decidedAt: now,
        returnUrlCiphertext,
        // Give the original window a full retrieval interval even if the
        // merchant denies immediately before the pending request expires.
        expiresAt: new Date(now.getTime() + MCP_AUTHORIZATION_CODE_TTL_MS),
      },
    });
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

  async claimAuthorizationRequestAndCreateCode(input: {
    requestId: string;
    returnUrlCiphertext?: string;
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
    const now = new Date();
    return prisma.$transaction(async (tx) => {
      const claimed = await tx.mcpAuthorizationRequest.updateMany({
        where: { id: input.requestId, decidedAt: null, expiresAt: { gt: now } },
        data: {
          decidedAt: now,
          returnUrlCiphertext: input.returnUrlCiphertext ?? null,
          // A completed handoff must not outlive its authorization code.
          expiresAt: input.expiresAt,
        },
      });
      if (claimed.count !== 1) return null;
      return tx.mcpAuthorizationCode.create({
        data: {
          codeHash: input.codeHash,
          userId: input.userId,
          storeId: input.storeId,
          clientId: input.clientId,
          redirectUri: input.redirectUri,
          scopes: input.scopes,
          resource: input.resource,
          codeChallenge: input.codeChallenge,
          expiresAt: input.expiresAt,
        },
      });
    });
  }

  findAuthorizationCode(codeHash: string) {
    return prisma.mcpAuthorizationCode.findUnique({ where: { codeHash } });
  }

  async consumeAuthorizationCode(codeHash: string) {
    const usedAt = new Date();
    const claimed = await prisma.mcpAuthorizationCode.updateMany({
      where: { codeHash, usedAt: null, expiresAt: { gt: usedAt } },
      data: { usedAt },
    });
    if (claimed.count !== 1) return null;
    return prisma.mcpAuthorizationCode.findUnique({ where: { codeHash } });
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
