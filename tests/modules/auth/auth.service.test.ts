import { describe, expect, it, vi } from 'vitest';
import type { AuthRepository } from '../../../src/modules/auth/auth.repository.js';
import { AuthService } from '../../../src/modules/auth/auth.service.js';

function createService() {
  const repository = {
    findUserByGoogleId: vi.fn(),
    findUserByEmail: vi.fn(),
    createGoogleUser: vi.fn(),
    createRefreshSession: vi.fn().mockResolvedValue({}),
  };

  return {
    repository,
    service: new AuthService(repository as unknown as AuthRepository),
  };
}

describe('AuthService Google sign-in', () => {
  it('logs in an existing Google user by stable Google subject, not email', async () => {
    const { repository, service } = createService();
    repository.findUserByGoogleId.mockResolvedValue({
      id: '11111111-1111-4111-8111-111111111111',
      email: 'stored@example.com',
      name: 'Owner',
      memberships: [],
    });

    const result = await service.oauthSignIn({
      googleId: 'google-subject-1',
      email: 'changed@example.com',
      name: 'Owner',
    });

    expect(result.user.email).toBe('stored@example.com');
    expect(repository.findUserByEmail).not.toHaveBeenCalled();
    expect(repository.createRefreshSession).toHaveBeenCalledOnce();
  });

  it('does not silently merge a Google login into an existing password account', async () => {
    const { repository, service } = createService();
    repository.findUserByGoogleId.mockResolvedValue(null);
    repository.findUserByEmail.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      email: 'owner@example.com',
      name: 'Owner',
      passwordHash: 'hash',
      memberships: [],
    });

    await expect(
      service.oauthSignIn({
        googleId: 'google-subject-2',
        email: 'Owner@Example.com',
        name: 'Owner',
      }),
    ).rejects.toMatchObject({ code: 'GOOGLE_EMAIL_IN_USE', statusCode: 409 });

    expect(repository.createGoogleUser).not.toHaveBeenCalled();
  });

  it('creates a verified passwordless user for a new Google identity', async () => {
    const { repository, service } = createService();
    repository.findUserByGoogleId.mockResolvedValue(null);
    repository.findUserByEmail.mockResolvedValue(null);
    repository.createGoogleUser.mockResolvedValue({
      id: '33333333-3333-4333-8333-333333333333',
      email: 'new@example.com',
      name: 'New User',
      memberships: [],
    });

    const result = await service.oauthSignIn({
      googleId: 'google-subject-3',
      email: 'New@Example.com',
      name: 'New User',
    });

    expect(repository.createGoogleUser).toHaveBeenCalledWith({
      email: 'new@example.com',
      name: 'New User',
      googleId: 'google-subject-3',
    });
    expect(result.user.email).toBe('new@example.com');
  });

  it('returns the same clean conflict when the email is claimed during creation', async () => {
    const { repository, service } = createService();
    repository.findUserByGoogleId.mockResolvedValue(null);
    repository.findUserByEmail
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: '44444444-4444-4444-8444-444444444444',
        email: 'race@example.com',
        name: 'Race Winner',
        passwordHash: 'hash',
        memberships: [],
      });
    repository.createGoogleUser.mockRejectedValue(new Error('unique constraint'));

    await expect(
      service.oauthSignIn({
        googleId: 'google-subject-4',
        email: 'race@example.com',
        name: 'Google User',
      }),
    ).rejects.toMatchObject({ code: 'GOOGLE_EMAIL_IN_USE', statusCode: 409 });
  });
});
