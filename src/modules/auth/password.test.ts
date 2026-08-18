import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from './password.js';

describe('password hashing', () => {
  it('verifies the correct password and rejects a different password', async () => {
    const encoded = await hashPassword('a-strong-password');

    await expect(verifyPassword('a-strong-password', encoded)).resolves.toBe(true);
    await expect(verifyPassword('wrong-password', encoded)).resolves.toBe(false);
  });

  it('uses a different salt for each hash', async () => {
    const first = await hashPassword('a-strong-password');
    const second = await hashPassword('a-strong-password');

    expect(first).not.toBe(second);
  });
});
