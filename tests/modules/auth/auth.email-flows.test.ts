import { describe, expect, it, vi } from 'vitest';
import type { AuthEmailDeliveryService } from '../../../src/modules/auth/auth.email-delivery.js';
import type { AuthRepository } from '../../../src/modules/auth/auth.repository.js';
import { AuthService } from '../../../src/modules/auth/auth.service.js';
import { hashAuthToken, hashPassword } from '../../../src/modules/auth/auth.utils.js';

function createService() {
  const repository = {
    findUserByEmail: vi.fn(),
    createUser: vi.fn(),
    findLatestAuthToken: vi.fn().mockResolvedValue(null),
    hasValidAuthToken: vi.fn().mockResolvedValue(true),
    consumeEmailVerificationToken: vi.fn(),
    resetPasswordWithToken: vi.fn(),
    createRefreshSession: vi.fn().mockResolvedValue({}),
    findRefreshSession: vi.fn(),
    revokeAllActiveSessions: vi.fn(),
    revokeSession: vi.fn(),
    rotateSession: vi.fn(),
    revokeSessionByTokenHash: vi.fn(),
  };
  const emailDelivery = {
    issueAndQueue: vi.fn().mockResolvedValue('delivery-1'),
    deliverNow: vi.fn().mockResolvedValue(true),
    processDue: vi.fn(),
  };

  return {
    repository,
    emailDelivery,
    service: new AuthService(
      repository as unknown as AuthRepository,
      emailDelivery as unknown as AuthEmailDeliveryService,
    ),
  };
}

describe('AuthService email verification', () => {
  it('registers a password user without creating a session and queues verification before delivery', async () => {
    const { repository, emailDelivery, service } = createService();
    repository.findUserByEmail.mockResolvedValue(null);
    repository.createUser.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      email: 'owner@example.com',
      name: 'Owner',
    });

    const result = await service.register({
      email: 'Owner@Example.com',
      password: 'very-secure-password',
      name: 'Owner',
    });

    expect(result).toMatchObject({
      emailVerificationRequired: true,
      verificationEmailSent: true,
      user: { email: 'owner@example.com' },
    });
    expect(repository.createRefreshSession).not.toHaveBeenCalled();
    expect(emailDelivery.issueAndQueue).toHaveBeenCalledOnce();
    expect(emailDelivery.deliverNow).toHaveBeenCalledWith('delivery-1');

    const queued = emailDelivery.issueAndQueue.mock.calls[0]![0];
    expect(queued.token.length).toBeGreaterThan(20);
    expect(queued).toEqual(
      expect.objectContaining({
        userId: '11111111-1111-4111-8111-111111111111',
        email: 'owner@example.com',
        type: 'EMAIL_VERIFICATION',
        tokenHash: hashAuthToken(queued.token),
      }),
    );
  });

  it('reports immediate delivery failure while leaving the queued delivery available for retry', async () => {
    const { repository, emailDelivery, service } = createService();
    repository.findUserByEmail.mockResolvedValue(null);
    repository.createUser.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      email: 'owner@example.com',
      name: null,
    });
    emailDelivery.deliverNow.mockResolvedValue(false);

    const result = await service.register({
      email: 'owner@example.com',
      password: 'very-secure-password',
    });

    expect(result.verificationEmailSent).toBe(false);
    expect(emailDelivery.issueAndQueue).toHaveBeenCalledOnce();
    expect(emailDelivery.deliverNow).toHaveBeenCalledOnce();
  });

  it('rejects correct password credentials until the email is verified', async () => {
    const { repository, service } = createService();
    repository.findUserByEmail.mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      email: 'owner@example.com',
      name: 'Owner',
      passwordHash: await hashPassword('very-secure-password'),
      emailVerifiedAt: null,
      memberships: [],
    });

    await expect(
      service.login({ email: 'owner@example.com', password: 'very-secure-password' }),
    ).rejects.toMatchObject({ code: 'EMAIL_NOT_VERIFIED', statusCode: 403 });
    expect(repository.createRefreshSession).not.toHaveBeenCalled();
  });

  it('consumes a hashed verification token', async () => {
    const { repository, service } = createService();
    repository.consumeEmailVerificationToken.mockResolvedValue({
      id: '44444444-4444-4444-8444-444444444444',
      email: 'owner@example.com',
      name: 'Owner',
      emailVerifiedAt: new Date(),
    });

    const result = await service.verifyEmail({ token: 'verification-token-value-123456' });

    expect(result.verified).toBe(true);
    expect(repository.consumeEmailVerificationToken).toHaveBeenCalledWith(
      hashAuthToken('verification-token-value-123456'),
    );
  });

  it('keeps resend verification responses generic for unknown addresses', async () => {
    const { repository, emailDelivery, service } = createService();
    repository.findUserByEmail.mockResolvedValue(null);

    await expect(service.resendVerification({ email: 'missing@example.com' })).resolves.toEqual({
      accepted: true,
    });
    expect(emailDelivery.issueAndQueue).not.toHaveBeenCalled();
  });
});

describe('AuthService password reset', () => {
  it('queues a reset email only for a verified password account', async () => {
    const { repository, emailDelivery, service } = createService();
    repository.findUserByEmail.mockResolvedValue({
      id: '55555555-5555-4555-8555-555555555555',
      email: 'owner@example.com',
      name: 'Owner',
      passwordHash: 'stored-hash',
      emailVerifiedAt: new Date(),
      memberships: [],
    });

    await expect(service.requestPasswordReset({ email: 'OWNER@example.com' })).resolves.toEqual({
      accepted: true,
    });
    expect(emailDelivery.issueAndQueue).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'PASSWORD_RESET', email: 'owner@example.com' }),
    );
  });

  it('returns the same accepted response for an unknown reset address', async () => {
    const { repository, emailDelivery, service } = createService();
    repository.findUserByEmail.mockResolvedValue(null);

    await expect(service.requestPasswordReset({ email: 'missing@example.com' })).resolves.toEqual({
      accepted: true,
    });
    expect(emailDelivery.issueAndQueue).not.toHaveBeenCalled();
  });

  it('hashes the new password and the reset token before persistence', async () => {
    const { repository, service } = createService();
    repository.resetPasswordWithToken.mockResolvedValue(true);

    await expect(
      service.resetPassword({
        token: 'password-reset-token-value-123456',
        password: 'a-new-secure-password',
      }),
    ).resolves.toEqual({ reset: true });

    const expectedTokenHash = hashAuthToken('password-reset-token-value-123456');
    expect(repository.hasValidAuthToken).toHaveBeenCalledWith(
      expectedTokenHash,
      'PASSWORD_RESET',
    );
    const [tokenHash, passwordHash] = repository.resetPasswordWithToken.mock.calls[0]!;
    expect(tokenHash).toBe(expectedTokenHash);
    expect(passwordHash).toMatch(/^scrypt\$v1\$/);
  });

  it('rejects invalid reset tokens before doing password persistence work', async () => {
    const { repository, service } = createService();
    repository.hasValidAuthToken.mockResolvedValue(false);

    await expect(
      service.resetPassword({
        token: 'invalid-password-reset-token-123456',
        password: 'a-new-secure-password',
      }),
    ).rejects.toMatchObject({ code: 'PASSWORD_RESET_TOKEN_INVALID', statusCode: 400 });
    expect(repository.resetPasswordWithToken).not.toHaveBeenCalled();
  });

  it('revokes legacy unverified refresh sessions instead of rotating them', async () => {
    const { repository, service } = createService();
    repository.findRefreshSession.mockResolvedValue({
      id: '66666666-6666-4666-8666-666666666666',
      userId: '77777777-7777-4777-8777-777777777777',
      revokedAt: null,
      expiresAt: new Date(Date.now() + 60_000),
      user: {
        id: '77777777-7777-4777-8777-777777777777',
        email: 'legacy@example.com',
        name: null,
        emailVerifiedAt: null,
        memberships: [],
      },
    });

    await expect(service.rotateRefreshSession('legacy-refresh-token')).rejects.toMatchObject({
      code: 'EMAIL_NOT_VERIFIED',
      statusCode: 403,
    });
    expect(repository.revokeSession).toHaveBeenCalledWith(
      '66666666-6666-4666-8666-666666666666',
    );
    expect(repository.rotateSession).not.toHaveBeenCalled();
  });
});
