import { AppError } from '../../errors/app-error.js';
import type { AuthRepository } from './auth.repository.js';
import type { LoginInput, RegisterInput } from './auth.schema.js';
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

export class AuthService {
  constructor(private readonly repository: AuthRepository) {}

  private async createSession(user: PublicUser, metadata: SessionMetadata): Promise<AuthResult> {
    const refreshToken = createRefreshToken();

    await this.repository.createRefreshSession({
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

  async register(input: RegisterInput, metadata: SessionMetadata): Promise<AuthResult> {
    const email = normalizeEmail(input.email);
    const existing = await this.repository.findUserByEmail(email);
    if (existing) {
      throw new AppError('An account with this email already exists', 409, 'EMAIL_IN_USE');
    }

    const user = await this.repository.createUser({
      email,
      name: input.name?.trim() || null,
      passwordHash: await hashPassword(input.password),
    });

    return this.createSession(user, metadata);
  }

  async login(input: LoginInput, metadata: SessionMetadata): Promise<AuthResult> {
    const user = await this.repository.findUserByEmail(normalizeEmail(input.email));

    if (!user?.passwordHash || !(await verifyPassword(input.password, user.passwordHash))) {
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    return this.createSession({ id: user.id, email: user.email, name: user.name }, metadata);
  }

  async rotateRefreshSession(
    refreshToken: string,
    metadata: SessionMetadata,
  ): Promise<AuthResult> {
    const session = await this.repository.findRefreshSession(hashRefreshToken(refreshToken));
    if (!session) throw new AppError('Invalid refresh session', 401, 'INVALID_SESSION');

    if (session.revokedAt) {
      await this.repository.revokeAllActiveSessions(session.userId);
      throw new AppError('Refresh token reuse detected', 401, 'SESSION_REUSED');
    }

    if (session.expiresAt <= new Date()) {
      await this.repository.revokeSession(session.id);
      throw new AppError('Refresh session expired', 401, 'SESSION_EXPIRED');
    }

    const nextRefreshToken = createRefreshToken();
    const nextTokenHash = hashRefreshToken(nextRefreshToken);
    const rotated = await this.repository.rotateSession({
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

  async revokeRefreshSession(refreshToken: string | undefined): Promise<void> {
    if (!refreshToken) return;
    await this.repository.revokeSessionByTokenHash(hashRefreshToken(refreshToken));
  }

  async getCurrentUser(userId: string) {
    const user = await this.repository.findUserById(userId);
    if (!user) throw new AppError('User not found', 401, 'UNAUTHORIZED');
    return user;
  }
}
