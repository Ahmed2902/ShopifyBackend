import { AppError } from '../../errors/app-error.js';
import { logger } from '../../lib/logger.js';
import type { StoreAccessClaim } from '../../types/auth.js';
import { authEmailSender, type AuthEmailSender } from './auth.email.js';
import { AuthRepository, type AuthTokenKind } from './auth.repository.js';
import type {
  EmailRequestInput,
  LoginInput,
  RegisterInput,
  ResetPasswordInput,
  VerifyEmailInput,
} from './auth.schema.js';
import {
  AUTH_EMAIL_COOLDOWN_MS,
  authTokenExpiry,
  createAuthToken,
  createRefreshToken,
  EMAIL_VERIFICATION_TTL_MS,
  hashAuthToken,
  hashPassword,
  hashRefreshToken,
  issueAccessToken,
  normalizeEmail,
  PASSWORD_RESET_TTL_MS,
  refreshSessionExpiry,
  verifyPassword,
} from './auth.utils.js';

export type GoogleSignInProfile = {
  googleId: string;
  email: string;
  name: string | null;
};

function googleAccountConflictError() {
  return new AppError(
    'This email is already linked to a different Google account.',
    409,
    'GOOGLE_ACCOUNT_CONFLICT',
  );
}

function invalidPasswordResetTokenError() {
  return new AppError(
    'Password reset token is invalid or expired',
    400,
    'PASSWORD_RESET_TOKEN_INVALID',
  );
}

export class AuthService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly emailSender: AuthEmailSender = authEmailSender,
  ) {}

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

  private async linkGoogleAccount(
    user: NonNullable<Awaited<ReturnType<AuthRepository['findUserByEmail']>>>,
    googleId: string,
    userAgent?: string,
  ) {
    if (user.googleId) throw googleAccountConflictError();

    try {
      if (await this.repository.linkGoogleAccount({ userId: user.id, googleId })) {
        const linkedUser = await this.repository.findUserByGoogleId(googleId);
        if (linkedUser) return this.createSession(linkedUser, userAgent);
      }
    } catch {
      // Another callback may have claimed the unique Google subject first.
    }

    const googleUser = await this.repository.findUserByGoogleId(googleId);
    if (googleUser) return this.createSession(googleUser, userAgent);

    const currentUser = await this.repository.findUserByEmail(user.email);
    if (currentUser?.googleId) throw googleAccountConflictError();
    return null;
  }

  private async deliverAuthEmail(input: {
    userId: string;
    email: string;
    type: AuthTokenKind;
    ttlMs: number;
    respectCooldown: boolean;
  }): Promise<boolean> {
    if (input.respectCooldown) {
      const latest = await this.repository.findLatestAuthToken(input.userId, input.type);
      if (latest && Date.now() - latest.createdAt.getTime() < AUTH_EMAIL_COOLDOWN_MS) {
        return false;
      }
    }

    const token = createAuthToken();
    const tokenHash = hashAuthToken(token);
    await this.repository.replaceAuthToken({
      userId: input.userId,
      type: input.type,
      tokenHash,
      expiresAt: authTokenExpiry(input.ttlMs),
    });

    try {
      if (input.type === 'EMAIL_VERIFICATION') {
        await this.emailSender.sendVerificationEmail(input.email, token);
      } else {
        await this.emailSender.sendPasswordResetEmail(input.email, token);
      }
      return true;
    } catch (error) {
      await this.repository.deleteAuthTokenByHash(tokenHash).catch(() => undefined);
      logger.warn(
        { err: error, userId: input.userId, type: input.type },
        'Auth email delivery failed',
      );
      return false;
    }
  }

  async register(input: RegisterInput) {
    const email = normalizeEmail(input.email);
    if (await this.repository.findUserByEmail(email)) {
      throw new AppError('An account with this email already exists', 409, 'EMAIL_IN_USE');
    }

    const user = await this.repository.createUser({
      email,
      name: input.name?.trim() || null,
      passwordHash: await hashPassword(input.password),
    });
    const verificationEmailSent = await this.deliverAuthEmail({
      userId: user.id,
      email: user.email,
      type: 'EMAIL_VERIFICATION',
      ttlMs: EMAIL_VERIFICATION_TTL_MS,
      respectCooldown: false,
    });

    return {
      user,
      emailVerificationRequired: true as const,
      verificationEmailSent,
    };
  }

  async login(input: LoginInput, userAgent?: string) {
    const user = await this.repository.findUserByEmail(normalizeEmail(input.email));
    if (!user?.passwordHash || !(await verifyPassword(input.password, user.passwordHash))) {
      throw new AppError('Invalid email or password', 401, 'INVALID_CREDENTIALS');
    }
    if (!user.emailVerifiedAt) {
      throw new AppError('Verify your email before signing in', 403, 'EMAIL_NOT_VERIFIED');
    }

    return this.createSession(
      { id: user.id, email: user.email, name: user.name, memberships: user.memberships },
      userAgent,
    );
  }

  async verifyEmail(input: VerifyEmailInput) {
    const user = await this.repository.consumeEmailVerificationToken(hashAuthToken(input.token));
    if (!user) {
      throw new AppError(
        'Email verification token is invalid or expired',
        400,
        'EMAIL_VERIFICATION_TOKEN_INVALID',
      );
    }
    return { verified: true as const, user };
  }

  async resendVerification(input: EmailRequestInput) {
    const user = await this.repository.findUserByEmail(normalizeEmail(input.email));
    if (user?.passwordHash && !user.emailVerifiedAt) {
      await this.deliverAuthEmail({
        userId: user.id,
        email: user.email,
        type: 'EMAIL_VERIFICATION',
        ttlMs: EMAIL_VERIFICATION_TTL_MS,
        respectCooldown: true,
      });
    }
    return { accepted: true as const };
  }

  async requestPasswordReset(input: EmailRequestInput) {
    const user = await this.repository.findUserByEmail(normalizeEmail(input.email));
    if (user?.passwordHash && user.emailVerifiedAt) {
      await this.deliverAuthEmail({
        userId: user.id,
        email: user.email,
        type: 'PASSWORD_RESET',
        ttlMs: PASSWORD_RESET_TTL_MS,
        respectCooldown: true,
      });
    }
    return { accepted: true as const };
  }

  async resetPassword(input: ResetPasswordInput) {
    const tokenHash = hashAuthToken(input.token);
    if (!(await this.repository.hasValidAuthToken(tokenHash, 'PASSWORD_RESET'))) {
      throw invalidPasswordResetTokenError();
    }

    const reset = await this.repository.resetPasswordWithToken(
      tokenHash,
      await hashPassword(input.password),
    );
    if (!reset) throw invalidPasswordResetTokenError();
    return { reset: true as const };
  }

  async oauthSignIn(profile: GoogleSignInProfile, userAgent?: string) {
    const existingGoogleUser = await this.repository.findUserByGoogleId(profile.googleId);
    if (existingGoogleUser) return this.createSession(existingGoogleUser, userAgent);

    const email = normalizeEmail(profile.email);
    const existingEmailUser = await this.repository.findUserByEmail(email);
    if (existingEmailUser) {
      const linkedSession = await this.linkGoogleAccount(
        existingEmailUser,
        profile.googleId,
        userAgent,
      );
      if (linkedSession) return linkedSession;
    }

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
      const concurrentEmailUser = await this.repository.findUserByEmail(email);
      if (concurrentEmailUser) {
        const linkedSession = await this.linkGoogleAccount(
          concurrentEmailUser,
          profile.googleId,
          userAgent,
        );
        if (linkedSession) return linkedSession;
      }
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

    if (!session.user.emailVerifiedAt) {
      await this.repository.revokeSession(session.id);
      throw new AppError('Verify your email before signing in', 403, 'EMAIL_NOT_VERIFIED');
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
    if (refreshToken)
      await this.repository.revokeSessionByTokenHash(hashRefreshToken(refreshToken));
  }

  async getCurrentUser(userId: string) {
    const user = await this.repository.findUserById(userId);
    if (!user) throw new AppError('User not found', 401, 'UNAUTHORIZED');
    return user;
  }
}

export const authService = new AuthService(new AuthRepository());
