import { prisma } from '../../lib/prisma.js';

export type AuthTokenKind = 'EMAIL_VERIFICATION' | 'PASSWORD_RESET';

const membershipSelect = {
  storeId: true,
  role: true,
} as const;

const sessionUserSelect = {
  id: true,
  email: true,
  name: true,
  emailVerifiedAt: true,
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
        googleId: true,
        emailVerifiedAt: true,
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

  async linkGoogleAccount(input: { userId: string; googleId: string }): Promise<boolean> {
    const now = new Date();
    const unverifiedUser = await prisma.user.updateMany({
      where: { id: input.userId, googleId: null, emailVerifiedAt: null },
      data: { googleId: input.googleId, emailVerifiedAt: now },
    });
    if (unverifiedUser.count === 1) return true;

    const verifiedUser = await prisma.user.updateMany({
      where: { id: input.userId, googleId: null },
      data: { googleId: input.googleId },
    });
    return verifiedUser.count === 1;
  }

  replaceAuthToken(input: {
    userId: string;
    type: AuthTokenKind;
    tokenHash: string;
    expiresAt: Date;
  }) {
    return prisma.authToken.upsert({
      where: { userId_type: { userId: input.userId, type: input.type } },
      create: input,
      update: {
        tokenHash: input.tokenHash,
        expiresAt: input.expiresAt,
        usedAt: null,
        createdAt: new Date(),
      },
    });
  }

  async replaceAuthTokenAndQueueEmail(input: {
    userId: string;
    type: AuthTokenKind;
    tokenHash: string;
    expiresAt: Date;
    recipient: string;
    tokenCiphertext: string;
  }): Promise<string> {
    return prisma.$transaction(async (tx) => {
      await tx.authToken.upsert({
        where: { userId_type: { userId: input.userId, type: input.type } },
        create: {
          userId: input.userId,
          type: input.type,
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
        },
        update: {
          tokenHash: input.tokenHash,
          expiresAt: input.expiresAt,
          usedAt: null,
          createdAt: new Date(),
        },
      });

      await tx.authEmailDelivery.updateMany({
        where: {
          userId: input.userId,
          type: input.type,
          status: 'PENDING',
          tokenHash: { not: input.tokenHash },
        },
        data: {
          status: 'SUPERSEDED',
          tokenCiphertext: null,
          processingStartedAt: null,
          lastError: null,
        },
      });

      const delivery = await tx.authEmailDelivery.create({
        data: {
          userId: input.userId,
          type: input.type,
          recipient: input.recipient,
          tokenHash: input.tokenHash,
          tokenCiphertext: input.tokenCiphertext,
        },
        select: { id: true },
      });
      return delivery.id;
    });
  }

  findLatestAuthToken(userId: string, type: AuthTokenKind) {
    return prisma.authToken.findUnique({
      where: { userId_type: { userId, type } },
      select: { createdAt: true },
    });
  }

  findCurrentAuthToken(userId: string, type: AuthTokenKind) {
    return prisma.authToken.findUnique({
      where: { userId_type: { userId, type } },
      select: { tokenHash: true, expiresAt: true, usedAt: true },
    });
  }

  deleteAuthTokenByHash(tokenHash: string) {
    return prisma.authToken.deleteMany({ where: { tokenHash } });
  }

  findDueAuthEmailDeliveryIds(limit: number, staleBefore: Date) {
    const now = new Date();
    return prisma.authEmailDelivery
      .findMany({
        where: {
          OR: [
            { status: 'PENDING', nextAttemptAt: { lte: now } },
            { status: 'PROCESSING', processingStartedAt: { lt: staleBefore } },
          ],
        },
        orderBy: [{ nextAttemptAt: 'asc' }, { createdAt: 'asc' }],
        take: limit,
        select: { id: true },
      })
      .then((rows) => rows.map((row) => row.id));
  }

  async claimAuthEmailDelivery(id: string, staleBefore: Date) {
    const now = new Date();
    const claimed = await prisma.authEmailDelivery.updateMany({
      where: {
        id,
        OR: [
          { status: 'PENDING', nextAttemptAt: { lte: now } },
          { status: 'PROCESSING', processingStartedAt: { lt: staleBefore } },
        ],
      },
      data: {
        status: 'PROCESSING',
        processingStartedAt: now,
        attempts: { increment: 1 },
      },
    });
    if (claimed.count !== 1) return null;

    return prisma.authEmailDelivery.findUnique({
      where: { id },
      select: {
        id: true,
        userId: true,
        type: true,
        recipient: true,
        tokenHash: true,
        tokenCiphertext: true,
        attempts: true,
      },
    });
  }

  getAuthEmailDeliveryStatus(id: string) {
    return prisma.authEmailDelivery
      .findUnique({ where: { id }, select: { status: true } })
      .then((row) => row?.status ?? null);
  }

  markAuthEmailDeliverySent(id: string, now = new Date()) {
    return prisma.authEmailDelivery.updateMany({
      where: { id, status: 'PROCESSING' },
      data: {
        status: 'SENT',
        sentAt: now,
        tokenCiphertext: null,
        processingStartedAt: null,
        lastError: null,
      },
    });
  }

  markAuthEmailDeliverySuperseded(id: string) {
    return prisma.authEmailDelivery.updateMany({
      where: { id, status: 'PROCESSING' },
      data: {
        status: 'SUPERSEDED',
        tokenCiphertext: null,
        processingStartedAt: null,
        lastError: null,
      },
    });
  }

  rescheduleAuthEmailDelivery(id: string, nextAttemptAt: Date, lastError: string) {
    return prisma.authEmailDelivery.updateMany({
      where: { id, status: 'PROCESSING' },
      data: {
        status: 'PENDING',
        nextAttemptAt,
        processingStartedAt: null,
        lastError,
      },
    });
  }

  markAuthEmailDeliveryDead(id: string, lastError: string) {
    return prisma.authEmailDelivery.updateMany({
      where: { id, status: 'PROCESSING' },
      data: {
        status: 'DEAD',
        tokenCiphertext: null,
        processingStartedAt: null,
        lastError,
      },
    });
  }

  async hasValidAuthToken(tokenHash: string, type: AuthTokenKind, now = new Date()) {
    const token = await prisma.authToken.findFirst({
      where: { tokenHash, type, usedAt: null, expiresAt: { gt: now } },
      select: { id: true },
    });
    return Boolean(token);
  }

  async consumeEmailVerificationToken(tokenHash: string, now = new Date()) {
    return prisma.$transaction(async (tx) => {
      const token = await tx.authToken.findUnique({
        where: { tokenHash },
        select: {
          id: true,
          userId: true,
          type: true,
          expiresAt: true,
          usedAt: true,
          user: { select: { emailVerifiedAt: true } },
        },
      });

      if (!token || token.type !== 'EMAIL_VERIFICATION' || token.usedAt || token.expiresAt <= now) {
        return null;
      }

      const claimed = await tx.authToken.updateMany({
        where: { id: token.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) return null;

      return tx.user.update({
        where: { id: token.userId },
        data: { emailVerifiedAt: token.user.emailVerifiedAt ?? now },
        select: { id: true, email: true, name: true, emailVerifiedAt: true },
      });
    });
  }

  async resetPasswordWithToken(tokenHash: string, passwordHash: string, now = new Date()) {
    return prisma.$transaction(async (tx) => {
      const token = await tx.authToken.findUnique({
        where: { tokenHash },
        select: { id: true, userId: true, type: true, expiresAt: true, usedAt: true },
      });

      if (!token || token.type !== 'PASSWORD_RESET' || token.usedAt || token.expiresAt <= now) {
        return false;
      }

      const claimed = await tx.authToken.updateMany({
        where: { id: token.id, usedAt: null, expiresAt: { gt: now } },
        data: { usedAt: now },
      });
      if (claimed.count !== 1) return false;

      await tx.user.update({ where: { id: token.userId }, data: { passwordHash } });
      await tx.refreshSession.updateMany({
        where: { userId: token.userId, revokedAt: null },
        data: { revokedAt: now },
      });

      return true;
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
      include: { user: { select: sessionUserSelect } },
    });
  }

  revokeAllActiveSessions(userId: string, revokedAt = new Date()) {
    return prisma.refreshSession.updateMany({
      where: { userId, revokedAt: null },
      data: { revokedAt },
    });
  }

  revokeSession(sessionId: string, revokedAt = new Date()) {
    return prisma.refreshSession.update({ where: { id: sessionId }, data: { revokedAt } });
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
