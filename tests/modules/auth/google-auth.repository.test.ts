import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { AuthRepository } from '../../../src/modules/auth/auth.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const createdUserIds: string[] = [];

async function cleanup() {
  while (createdUserIds.length > 0) {
    await prisma.user.deleteMany({ where: { id: createdUserIds.pop()! } });
  }
}

afterEach(cleanup);

describeDatabase('Google user persistence', () => {
  it('creates a verified passwordless user with a unique Google subject', async () => {
    const repository = new AuthRepository();
    const googleId = `google-${randomUUID()}`;
    const email = `google-${randomUUID()}@example.com`;

    const user = await repository.createGoogleUser({
      email,
      name: 'Google User',
      googleId,
    });
    createdUserIds.push(user.id);

    const persisted = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(persisted.googleId).toBe(googleId);
    expect(persisted.passwordHash).toBeNull();
    expect(persisted.emailVerifiedAt).toBeInstanceOf(Date);

    await expect(
      repository.createGoogleUser({
        email: `other-${randomUUID()}@example.com`,
        name: 'Other User',
        googleId,
      }),
    ).rejects.toBeTruthy();
  });
});
