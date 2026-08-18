import { describe, expect, it } from 'vitest';
import {
  createRefreshToken,
  hashPassword,
  hashRefreshToken,
  issueAccessToken,
  verifyAccessToken,
  verifyPassword,
} from './auth.utils.js';

describe('auth utilities', () => {
  it('hashes and verifies passwords with unique salts', async () => {
    const first = await hashPassword('a-strong-password');
    const second = await hashPassword('a-strong-password');

    expect(first).not.toBe(second);
    await expect(verifyPassword('a-strong-password', first)).resolves.toBe(true);
    await expect(verifyPassword('wrong-password', first)).resolves.toBe(false);
  });

  it('issues and verifies access tokens', async () => {
    const userId = 'b3ecf1b1-49bf-4ecf-982a-43db2f481cf0';
    const token = await issueAccessToken(userId);
    await expect(verifyAccessToken(token)).resolves.toBe(userId);
  });

  it('creates opaque refresh tokens and deterministic hashes', () => {
    const token = createRefreshToken();
    expect(token.length).toBeGreaterThan(40);
    expect(hashRefreshToken(token)).toBe(hashRefreshToken(token));
    expect(hashRefreshToken(token)).not.toBe(token);
  });
});
