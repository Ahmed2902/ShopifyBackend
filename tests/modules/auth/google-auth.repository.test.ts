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

  it('links an existing password user without changing its row, password, or existing relations', async () => {
    const repository = new AuthRepository();
    const email = `password-${randomUUID()}@example.com`;
    const passwordHash = `hash-${randomUUID()}`;
    const user = await prisma.user.create({
      data: { email, name: 'Password User', passwordHash },
    });
    createdUserIds.push(user.id);

    const result = await repository.linkGoogleAccount({
      userId: user.id,
      googleId: `google-${randomUUID()}`,
    });

    expect(result).toBe(true);

    const persisted = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(persisted.passwordHash).toBe(passwordHash);
    expect(persisted.googleId).toBeTruthy();
    expect(persisted.emailVerifiedAt).toBeInstanceOf(Date);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
  });

  it('does not replace a linked Google subject and makes same-subject linking idempotent', async () => {
    const repository = new AuthRepository();
    const email = `linked-${randomUUID()}@example.com`;
    const googleId = `google-${randomUUID()}`;
    const user = await prisma.user.create({
      data: { email, name: 'Linked User', passwordHash: 'hash', googleId },
    });
    createdUserIds.push(user.id);

    const sameIdentity = await repository.linkGoogleAccount({ userId: user.id, googleId });
    const differentIdentity = await repository.linkGoogleAccount({
      userId: user.id,
      googleId: `google-${randomUUID()}`,
    });

    expect(sameIdentity).toBe(false);
    expect(differentIdentity).toBe(false);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).googleId).toBe(
      googleId,
    );
  });

  it('handles concurrent callbacks for the same account without duplicate users', async () => {
    const repository = new AuthRepository();
    const email = `concurrent-${randomUUID()}@example.com`;
    const googleId = `google-${randomUUID()}`;
    const user = await prisma.user.create({
      data: { email, name: 'Concurrent User', passwordHash: 'hash' },
    });
    createdUserIds.push(user.id);

    const results = await Promise.all(
      Array.from({ length: 4 }, () => repository.linkGoogleAccount({ userId: user.id, googleId })),
    );

    expect(results).toContain(true);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
    expect(await prisma.user.count({ where: { googleId } })).toBe(1);
    expect((await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).googleId).toBe(
      googleId,
    );
  });
});
