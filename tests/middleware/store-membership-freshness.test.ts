import type { NextFunction, Request, Response } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { createRequireStoreMembership, requireRole } from '../../src/middleware/store.middleware.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function requestContext(input?: {
  roleClaim?: 'OWNER' | 'ADMIN' | 'MEMBER';
  includeStoreClaim?: boolean;
}) {
  return {
    params: { storeId },
    context: {
      userId: 'user-1',
      storeAccess:
        input?.includeStoreClaim === false
          ? []
          : [{ storeId, role: input?.roleClaim ?? 'MEMBER' }],
    },
  } as unknown as Request;
}

const response = {} as Response;

describe('fresh store authorization', () => {
  it('uses the current database role instead of a stale privileged JWT role', async () => {
    const repository = {
      findMembership: vi.fn().mockResolvedValue({ role: 'MEMBER' as const }),
    };
    const next = vi.fn() as NextFunction;
    const req = requestContext({ roleClaim: 'ADMIN' });

    await createRequireStoreMembership(repository)(req, response, next);

    expect(repository.findMembership).toHaveBeenCalledWith('user-1', storeId);
    expect(req.context.role).toBe('MEMBER');
    expect(next).toHaveBeenCalledTimes(1);

    let roleError: unknown;
    try {
      requireRole('OWNER', 'ADMIN')(req, response, vi.fn());
    } catch (error) {
      roleError = error;
    }
    expect(roleError).toMatchObject({ statusCode: 403, code: 'FORBIDDEN' });
  });

  it('revokes store access immediately when the membership row has been removed', async () => {
    const repository = {
      findMembership: vi.fn().mockResolvedValue(null),
    };
    const req = requestContext({ roleClaim: 'OWNER' });

    await expect(
      createRequireStoreMembership(repository)(req, response, vi.fn()),
    ).rejects.toMatchObject({ statusCode: 404, code: 'STORE_NOT_FOUND' });

    expect(req.context.storeId).toBeUndefined();
    expect(req.context.role).toBeUndefined();
  });

  it('honors a newly granted membership without waiting for the access token to refresh', async () => {
    const repository = {
      findMembership: vi.fn().mockResolvedValue({ role: 'ADMIN' as const }),
    };
    const next = vi.fn() as NextFunction;
    const req = requestContext({ includeStoreClaim: false });

    await createRequireStoreMembership(repository)(req, response, next);

    expect(req.context.storeId).toBe(storeId);
    expect(req.context.role).toBe('ADMIN');
    expect(next).toHaveBeenCalledTimes(1);
  });
});
