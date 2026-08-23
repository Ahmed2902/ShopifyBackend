import { prisma } from '../../lib/prisma.js';

const membershipSelect = {
  storeId: true,
  role: true,
} as const;

const sessionUserSelect = {
  id: true,
  email: true,
  name: true,
  memberships: { select: membershipSelect },
} as const;

export class AuthRepository {
  findUserByEmail(email: string) {
    return prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        email: true,
        name: true,
        passwordHash: true,
        memberships: { select: membershipSelect },
      },
    });
  }

  findUserByGoogleId(googleId: string) {
    return prisma.user.findUnique({
      where: { googleId },
      select: sessionUserSelect,
    });
  }

  findUserById(userId: string) {
    return prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, email: true, name: true, emailVerifiedAt: true, createdAt: true },
    });
  }

  createUser(input: { email: string; name: string | null; passwordHash: string }) {
    return prisma.user.create({
      data: input,
      select: { id: true, email: true, name: true },
    });
  }

  createGoogleUser(input: { email: string; name: string | null; googleId: string }) {
    return prisma.user.create({
      data: {
        email: input.email,
        name: input.name,
        googleId: input.googleId,
        emailVerifiedAt: new Date(),
      },
      select: sessionUserSelect,
    });
  }

  createRefreshSession(input: {
    userId: string;
    tokenHash: string;
    expiresAt: Date;
    userAgent: string | null;
  }) {
    return prisma.refreshSession.create({ data: input });
  }

  findRefreshSession(tokenHash: string) {
    return prisma.refreshSession.findUnique({
      where: { tokenHash },
      include: {
        user: { select: sessionUserSelect },
      },
    });
  }

  revokeAllActiveSessions(userId: string, revokedAt = new Date()) {
    return prisma.refreshSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt },
    });
  }

  revokeSession(sessionId: string, revokedAt = new Date()) {
    return prisma.refreshSession.update({
      where: { id: sessionId },
      data: { revokedAt },
    });
  }

  async rotateSession(input: {
    sessionId: string;
    userId: string;
    nextTokenHash: string;
    expiresAt: Date;
    userAgent: string | null;
  }) {
    const now = new Date();

    return prisma.$transaction(async (tx) => {
      const claimed = await tx.refreshSession.updateMany({
        where: { id: input.sessionId, revokedAt: null },
        data: {
          revokedAt: now,
          lastUsedAt: now,
          replacedByTokenHash: input.nextTokenHash,
        },
      });

      if (claimed.count !== 1) return false;

      await tx.refreshSession.create({
        data: {
          userId: input.userId,
          tokenHash: input.nextTokenHash,
          expiresAt: input.expiresAt,
          userAgent: input.userAgent,
        },
      });

      return true;
    });
  }

  revokeSessionByTokenHash(tokenHash: string, revokedAt = new Date()) {
    return prisma.refreshSession.updateMany({
      where: { tokenHash, revokedAt: null },
      data: { revokedAt },
    });
  }
}
