import { AppError } from '../../errors/app-error.js';
import { authRepository } from './auth.repository.js';
import {
  createRefreshToken,
  hashPassword,
  hashRefreshToken,
  issueAccessToken,
  normalizeEmail,
  refreshSessionExpiry,
  verifyPassword,
} from './auth.utils.js';

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

async function createSession(user: PublicUser, metadata: SessionMetadata): Promise<AuthResult> {
  const refreshToken = createRefreshToken();

  await authRepository.createRefreshSession({
    userId: user.id,
    tokenHash: hashRefreshToken(refreshToken),
    expiresAt: refreshSessionExpiry(),
    userAgent: metadata.userAgent ?? null,
  });

  return {
    user,
    accessToken: await issueAccessToken(user.id),
    refreshToken,
  };
}

export async function registerUser(
  input: { email: string; password: string; name?: string },
  metadata: SessionMetadata,
): Promise<AuthResult> {
  const email = normalizeEmail(input.email);
  const existing = await authRepository.findUserByEmail(email);
  if (existing) throw new AppError('An account with this email already exists', 409, 'EMAIL_IN_USE');

  const user = await authRepository.createUser({
    email,
    name: input.name?.trim() || null,
    passwordHash: await hashPassword(input.password),
  });

  return createSession(user, metadata);
}

export async function loginUser(
  input: { email: string; password: string },
  metadata: SessionMetadata,
): Promise<AuthResult> {
  const user = await authRepository.findUserByEmail(normalizeEmail(input.email));

  if (!user?.passwordHash || !(await verifyPassword(input.password, user.passwordHash))) {
    throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
  }

  return createSession({ id: user.id, email: user.email, name: user.name }, metadata);
}

export async function rotateRefreshSession(
  refreshToken: string,
  metadata: SessionMetadata,
): Promise<AuthResult> {
  const session = await authRepository.findRefreshSession(hashRefreshToken(refreshToken));
  if (!session) throw new AppError('Invalid refresh session', 401, 'INVALID_SESSION');

  if (session.revokedAt) {
    await authRepository.revokeAllActiveSessions(session.userId);
    throw new AppError('Refresh token reuse detected', 401, 'SESSION_REUSED');
  }

  if (session.expiresAt <= new Date()) {
    await authRepository.revokeSession(session.id);
    throw new AppError('Refresh session expired', 401, 'SESSION_EXPIRED');
  }

  const nextRefreshToken = createRefreshToken();
  const nextTokenHash = hashRefreshToken(nextRefreshToken);
  const rotated = await authRepository.rotateSession({
    sessionId: session.id,
    userId: session.userId,
    nextTokenHash,
    expiresAt: refreshSessionExpiry(),
    userAgent: metadata.userAgent ?? null,
  });

  if (!rotated) {
    throw new AppError('Refresh session was already rotated', 401, 'SESSION_REUSED');
  }

  return {
    user: session.user,
    accessToken: await issueAccessToken(session.userId),
    refreshToken: nextRefreshToken,
  };
}

export async function revokeRefreshSession(refreshToken: string | undefined): Promise<void> {
  if (!refreshToken) return;
  await authRepository.revokeSessionByTokenHash(hashRefreshToken(refreshToken));
}

export async function getCurrentUser(userId: string) {
  const user = await authRepository.findUserById(userId);
  if (!user) throw new AppError('User not found', 401, 'UNAUTHORIZED');
  return user;
}
