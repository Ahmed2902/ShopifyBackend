import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';
import { prisma } from '../../lib/prisma.js';
import { hashPassword, verifyPassword } from './password.js';
import { createRefreshToken, hashRefreshToken, issueAccessToken } from './tokens.js';

interface SessionMetadata {
  userAgent?: string;
}

interface PublicUser {
  id: string;
  email: string;
  name: string | null;
}

export interface AuthResult {
  user: PublicUser;
  accessToken: string;
  refreshToken: string;
}

function publicUser(user: PublicUser): PublicUser {
  return { id: user.id, email: user.email, name: user.name };
}

function sessionExpiry(): Date {
  return new Date(Date.now() + env.REFRESH_TOKEN_TTL_DAYS * 24 * 60 * 60 * 1000);
}

async function createSession(user: PublicUser, metadata: SessionMetadata): Promise<AuthResult> {
  const refreshToken = createRefreshToken();
  const tokenHash = hashRefreshToken(refreshToken);

  await prisma.refreshSession.create({
    data: {
      userId: user.id,
      tokenHash,
      expiresAt: sessionExpiry(),
      userAgent: metadata.userAgent ?? null,
    },
  });

  return {
    user: publicUser(user),
    accessToken: await issueAccessToken(user.id),
    refreshToken,
  };
}

export async function registerUser(
  input: { email: string; password: string; name?: string },
  metadata: SessionMetadata,
): Promise<AuthResult> {
  const email = input.email.trim().toLowerCase();
  const existing = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  if (existing) throw new AppError('An account with this email already exists', 409, 'EMAIL_IN_USE');

  const user = await prisma.user.create({
    data: {
      email,
      name: input.name?.trim() || null,
      passwordHash: await hashPassword(input.password),
    },
    select: { id: true, email: true, name: true },
  });

  return createSession(user, metadata);
}

export async function loginUser(
  input: { email: string; password: string },
  metadata: SessionMetadata,
): Promise<AuthResult> {
  const email = input.email.trim().toLowerCase();
  const user = await prisma.user.findUnique({
    where: { email },
    select: { id: true, email: true, name: true, passwordHash: true },
  });

  if (!user?.passwordHash || !(await verifyPassword(input.password, user.passwordHash))) {
    throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
  }

  return createSession(user, metadata);
}

export async function rotateRefreshSession(
  refreshToken: string,
  metadata: SessionMetadata,
): Promise<AuthResult> {
  const tokenHash = hashRefreshToken(refreshToken);
  const session = await prisma.refreshSession.findUnique({
    where: { tokenHash },
    include: { user: { select: { id: true, email: true, name: true } } },
  });

  if (!session) throw new AppError('Invalid refresh session', 401, 'INVALID_SESSION');

  if (session.revokedAt) {
    await prisma.refreshSession.updateMany({
      where: { userId: session.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    throw new AppError('Refresh token reuse detected', 401, 'SESSION_REUSED');
  }

  if (session.expiresAt <= new Date()) {
    await prisma.refreshSession.update({
      where: { id: session.id },
      data: { revokedAt: new Date() },
    });
    throw new AppError('Refresh session expired', 401, 'SESSION_EXPIRED');
  }

  const nextRefreshToken = createRefreshToken();
  const nextTokenHash = hashRefreshToken(nextRefreshToken);
  const now = new Date();

  await prisma.$transaction(async (tx) => {
    const claimed = await tx.refreshSession.updateMany({
      where: { id: session.id, revokedAt: null },
      data: {
        revokedAt: now,
        lastUsedAt: now,
        replacedByTokenHash: nextTokenHash,
      },
    });

    if (claimed.count !== 1) {
      throw new AppError('Refresh session was already rotated', 401, 'SESSION_REUSED');
    }

    await tx.refreshSession.create({
      data: {
        userId: session.userId,
        tokenHash: nextTokenHash,
        expiresAt: sessionExpiry(),
        userAgent: metadata.userAgent ?? null,
      },
    });
  });

  return {
    user: publicUser(session.user),
    accessToken: await issueAccessToken(session.userId),
    refreshToken: nextRefreshToken,
  };
}

export async function revokeRefreshSession(refreshToken: string | undefined): Promise<void> {
  if (!refreshToken) return;

  await prisma.refreshSession.updateMany({
    where: { tokenHash: hashRefreshToken(refreshToken), revokedAt: null },
    data: { revokedAt: new Date() },
  });
}
