import { describe, expect, it, vi } from 'vitest';
import type { AuthRepository } from '../../../src/modules/auth/auth.repository.js';
import { AuthService } from '../../../src/modules/auth/auth.service.js';
import { hashPassword } from '../../../src/modules/auth/auth.utils.js';

function createService() {
  const repository = {
    findUserByGoogleId: vi.fn(),
    findUserByEmail: vi.fn(),
    linkGoogleAccount: vi.fn(),
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

  it('links a verified Google identity to an existing password account', async () => {
    const { repository, service } = createService();
    repository.findUserByGoogleId.mockResolvedValue(null);
    repository.findUserByEmail.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      email: 'owner@example.com',
      name: 'Owner',
      passwordHash: 'hash',
      googleId: null,
      memberships: [],
    });
    repository.linkGoogleAccount.mockResolvedValue(true);
    repository.findUserByGoogleId.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: '22222222-2222-4222-8222-222222222222',
      email: 'owner@example.com',
      name: 'Owner',
      memberships: [],
    });

    const result = await service.oauthSignIn({
      googleId: 'google-subject-2',
      email: 'Owner@Example.com',
      name: 'Owner',
    });

    expect(result.user.id).toBe('22222222-2222-4222-8222-222222222222');
    expect(repository.linkGoogleAccount).toHaveBeenCalledWith({
      userId: '22222222-2222-4222-8222-222222222222',
      googleId: 'google-subject-2',
    });
    expect(repository.createGoogleUser).not.toHaveBeenCalled();
  });

  it('rejects a matching email that is linked to a different Google subject', async () => {
    const { repository, service } = createService();
    repository.findUserByGoogleId.mockResolvedValue(null);
    repository.findUserByEmail.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      email: 'owner@example.com',
      name: 'Owner',
      passwordHash: 'hash',
      googleId: 'google-subject-1',
      memberships: [],
    });
    await expect(
      service.oauthSignIn({
        googleId: 'google-subject-2',
        email: 'owner@example.com',
        name: 'Owner',
      }),
    ).rejects.toMatchObject({ code: 'GOOGLE_ACCOUNT_CONFLICT', statusCode: 409 });

    expect(repository.createGoogleUser).not.toHaveBeenCalled();
  });

  it('continues to allow password login after Google linking', async () => {
    const { repository, service } = createService();
    const passwordHash = await hashPassword('correct horse battery staple');
    repository.findUserByGoogleId.mockResolvedValue(null);
    repository.findUserByEmail.mockResolvedValue({
      id: '22222222-2222-4222-8222-222222222222',
      email: 'owner@example.com',
      name: 'Owner',
      passwordHash,
      googleId: null,
      emailVerifiedAt: new Date(),
      memberships: [],
    });
    repository.linkGoogleAccount.mockResolvedValue(true);
    repository.findUserByGoogleId.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: '22222222-2222-4222-8222-222222222222',
      email: 'owner@example.com',
      name: 'Owner',
      memberships: [],
    });

    await service.oauthSignIn({
      googleId: 'google-subject-2',
      email: 'owner@example.com',
      name: 'Owner',
    });
    const passwordResult = await service.login({
      email: 'owner@example.com',
      password: 'correct horse battery staple',
    });

    expect(passwordResult.user.id).toBe('22222222-2222-4222-8222-222222222222');
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

  it('links safely when a password account is created while Google sign-in is in progress', async () => {
    const { repository, service } = createService();
    repository.findUserByGoogleId
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: '44444444-4444-4444-8444-444444444444',
        email: 'race@example.com',
        name: 'Race Winner',
        memberships: [],
      });
    repository.findUserByEmail.mockResolvedValueOnce(null).mockResolvedValueOnce({
      id: '44444444-4444-4444-8444-444444444444',
      email: 'race@example.com',
      name: 'Race Winner',
      passwordHash: 'hash',
      googleId: null,
      memberships: [],
    });
    repository.createGoogleUser.mockRejectedValue(new Error('unique constraint'));
    repository.linkGoogleAccount.mockResolvedValue(true);

    const result = await service.oauthSignIn({
      googleId: 'google-subject-4',
      email: 'race@example.com',
      name: 'Google User',
    });

    expect(result.user.id).toBe('44444444-4444-4444-8444-444444444444');
  });
});
