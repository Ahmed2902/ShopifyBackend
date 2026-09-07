import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { errorHandler } from '../../src/middleware/error-handler.js';
import { requireRole, requireStoreMembership } from '../../src/middleware/store.middleware.js';
import type { StoreAccessClaim } from '../../src/types/auth.js';

const storeA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const storeB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function appFor(input: { userId?: string; stores?: StoreAccessClaim[] }) {
  const app = express();
  app.use((req, _res, next) => {
    req.context = {
      userId: input.userId,
      storeAccess: input.stores,
    };
    next();
  });
  return app;
}

describe('store isolation middleware', () => {
  it('returns the same not-found boundary for a syntactically valid store the user does not belong to', async () => {
    const app = appFor({
      userId: 'user-a',
      stores: [{ storeId: storeA, role: 'OWNER' }],
    });
    const reached = vi.fn();
    app.get('/stores/:storeId/protected', requireStoreMembership, (_req, res) => {
      reached();
      res.status(204).send();
    });
    app.use(errorHandler);

    const response = await request(app).get(`/stores/${storeB}/protected`).expect(404);

    expect(response.body.error).toMatchObject({ code: 'STORE_NOT_FOUND' });
    expect(reached).not.toHaveBeenCalled();
  });

  it('binds the authorized store and role from the signed access claims instead of trusting request data', async () => {
    const app = appFor({
      userId: 'user-a',
      stores: [
        { storeId: storeA, role: 'MEMBER' },
        { storeId: storeB, role: 'ADMIN' },
      ],
    });
    app.get('/stores/:storeId/protected', requireStoreMembership, (req, res) => {
      res.status(200).json({ storeId: req.context.storeId, role: req.context.role });
    });
    app.use(errorHandler);

    await request(app)
      .get(`/stores/${storeB}/protected`)
      .expect(200, { storeId: storeB, role: 'ADMIN' });
  });

  it('does not let a MEMBER invoke owner/admin mutations after store membership succeeds', async () => {
    const app = appFor({
      userId: 'user-a',
      stores: [{ storeId: storeA, role: 'MEMBER' }],
    });
    const mutated = vi.fn();
    app.post(
      '/stores/:storeId/install-pixel',
      requireStoreMembership,
      requireRole('OWNER', 'ADMIN'),
      (_req, res) => {
        mutated();
        res.status(204).send();
      },
    );
    app.use(errorHandler);

    const response = await request(app).post(`/stores/${storeA}/install-pixel`).expect(403);

    expect(response.body.error).toMatchObject({ code: 'FORBIDDEN' });
    expect(mutated).not.toHaveBeenCalled();
  });

  it.each(['OWNER', 'ADMIN'] as const)('allows %s through privileged store mutations', async (role) => {
    const app = appFor({
      userId: 'user-a',
      stores: [{ storeId: storeA, role }],
    });
    app.post(
      '/stores/:storeId/install-pixel',
      requireStoreMembership,
      requireRole('OWNER', 'ADMIN'),
      (req, res) => res.status(200).json({ storeId: req.context.storeId, role: req.context.role }),
    );
    app.use(errorHandler);

    await request(app)
      .post(`/stores/${storeA}/install-pixel`)
      .expect(200, { storeId: storeA, role });
  });

  it('fails before store lookup semantics when authentication context is missing', async () => {
    const app = appFor({ stores: [{ storeId: storeA, role: 'OWNER' }] });
    app.get('/stores/:storeId/protected', requireStoreMembership, (_req, res) => res.status(204).send());
    app.use(errorHandler);

    const response = await request(app).get(`/stores/${storeA}/protected`).expect(500);
    expect(response.body.error).toMatchObject({ code: 'AUTH_CONTEXT_MISSING' });
  });
});
