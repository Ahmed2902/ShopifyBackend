import { describe, expect, it } from 'vitest';
import {
  createRefreshToken,
  hashPassword,
  hashRefreshToken,
  issueAccessToken,
  verifyAccessToken,
  verifyPassword,
} from '../../../src/modules/auth/auth.utils.js';

describe('auth utilities', () => {
  it('hashes and verifies passwords with unique salts', async () => {
    const first = await hashPassword('a-strong-password');
    const second = await hashPassword('a-strong-password');

    expect(first).not.toBe(second);
    await expect(verifyPassword('a-strong-password', first)).resolves.toBe(true);
    await expect(verifyPassword('wrong-password', first)).resolves.toBe(false);
  });

  it('issues and verifies access tokens with Store access claims', async () => {
    const userId = 'b3ecf1b1-49bf-4ecf-982a-43db2f481cf0';
    const stores = [
      { storeId: '11111111-1111-4111-8111-111111111111', role: 'OWNER' as const },
      { storeId: '22222222-2222-4222-8222-222222222222', role: 'MEMBER' as const },
    ];

    const token = await issueAccessToken(userId, stores);
    await expect(verifyAccessToken(token)).resolves.toEqual({ userId, stores });
  });

  it('issues access tokens without Store access for new users', async () => {
    const userId = 'b3ecf1b1-49bf-4ecf-982a-43db2f481cf0';
    const token = await issueAccessToken(userId);
    await expect(verifyAccessToken(token)).resolves.toEqual({ userId, stores: [] });
  });

  it('creates opaque refresh tokens and deterministic hashes', () => {
    const token = createRefreshToken();
    expect(token.length).toBeGreaterThan(40);
    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
    expect(hashRefreshToken(token)).not.toBe(token);
  });
});
