import { AppError } from '../../errors/app-error.js';
import type { StoreAccessClaim } from '../../types/auth.js';
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

export type GoogleSignInProfile = {
  googleId: string;
  email: string;
  name: string | null;
};

function googleEmailInUseError() {
  return new AppError(
    'An account with this email already exists. Sign in with your password.',
    409,
    'GOOGLE_EMAIL_IN_USE',
  );
}

export class AuthService {
  constructor(private readonly repository: AuthRepository) {}

  private async createSession(
    user: { id: string; email: string; name: string | null; memberships: StoreAccessClaim[] },
    userAgent?: string,
  ) {
    const refreshToken = createRefreshToken();
    await this.repository.createRefreshSession({
      userId: user.id,
      tokenHash: hashRefreshToken(refreshToken),
      expiresAt: refreshSessionExpiry(),
      userAgent: userAgent ?? null,
    });

    return {
      user: { id: user.id, email: user.email, name: user.name },
      accessToken: await issueAccessToken(user.id, user.memberships),
      refreshToken,
    };
  }

  async register(input: RegisterInput, userAgent?: string) {
    const email = normalizeEmail(input.email);
    if (await this.repository.findUserByEmail(email)) {
      throw new AppError('An account with this email already exists', 409, 'EMAIL_IN_USE');
    }

    const user = await this.repository.createUser({
      email,
      name: input.name?.trim() || null,
      passwordHash: await hashPassword(input.password),
    });
    return this.createSession({ ...user, memberships: [] }, userAgent);
  }

  async login(input: LoginInput, userAgent?: string) {
    const user = await this.repository.findUserByEmail(normalizeEmail(input.email));
    if (!user?.passwordHash || !(await verifyPassword(input.password, user.passwordHash))) {
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }

    return this.createSession(
      { id: user.id, email: user.email, name: user.name, memberships: user.memberships },
      userAgent,
    );
  }

  async oauthSignIn(profile: GoogleSignInProfile, userAgent?: string) {
    const existingGoogleUser = await this.repository.findUserByGoogleId(profile.googleId);
    if (existingGoogleUser) return this.createSession(existingGoogleUser, userAgent);

    const email = normalizeEmail(profile.email);
    if (await this.repository.findUserByEmail(email)) throw googleEmailInUseError();

    try {
      const user = await this.repository.createGoogleUser({
        email,
        name: profile.name,
        googleId: profile.googleId,
      });
      return this.createSession(user, userAgent);
    } catch (error) {
      const concurrentlyCreated = await this.repository.findUserByGoogleId(profile.googleId);
      if (concurrentlyCreated) return this.createSession(concurrentlyCreated, userAgent);
      if (await this.repository.findUserByEmail(email)) throw googleEmailInUseError();
      throw error;
    }
  }

  async rotateRefreshSession(refreshToken: string, userAgent?: string) {
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
    const rotated = await this.repository.rotateSession({
      sessionId: session.id,
      userId: session.userId,
      nextTokenHash: hashRefreshToken(nextRefreshToken),
      expiresAt: refreshSessionExpiry(),
      userAgent: userAgent ?? null,
    });
    if (!rotated) {
      throw new AppError('Refresh session was already rotated', 401, 'SESSION_REUSED');
    }

    return {
      user: { id: session.user.id, email: session.user.email, name: session.user.name },
      accessToken: await issueAccessToken(session.userId, session.user.memberships),
      refreshToken: nextRefreshToken,
    };
  }

  async revokeRefreshSession(refreshToken: string | undefined): Promise<void> {
    if (refreshToken) await this.repository.revokeSessionByTokenHash(hashRefreshToken(refreshToken));
  }

  async getCurrentUser(userId: string) {
    const user = await this.repository.findUserById(userId);
    if (!user) throw new AppError('User not found', 401, 'UNAUTHORIZED');
    return user;
  }
}
