import { describe, expect, it } from 'vitest';
import {
  createRefreshToken,
  hashRefreshToken,
  issueAccessToken,
  verifyAccessToken,
} from './tokens.js';

describe('authentication tokens', () => {
  it('issues and verifies an access token', async () => {
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
