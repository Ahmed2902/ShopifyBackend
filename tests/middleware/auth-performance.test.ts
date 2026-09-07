import express from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../../src/lib/prisma.js', () => ({
  prisma: new Proxy(
    {},
    {
      get() {
        throw new Error('Auth middleware must not touch Prisma');
      },
    },
  ),
}));

import { requireAuth } from '../../src/middleware/auth.middleware.js';
import { errorHandler } from '../../src/middleware/error-handler.js';
import { requireStoreMembership } from '../../src/middleware/store.middleware.js';
import { issueAccessToken } from '../../src/modules/auth/auth.utils.js';

describe('auth request performance contract', () => {
  it('authorizes a protected store request entirely from signed access claims', async () => {
    const userId = '11111111-1111-4111-8111-111111111111';
    const storeId = '22222222-2222-4222-8222-222222222222';
    const token = await issueAccessToken(userId, [{ storeId, role: 'OWNER' }]);

    const app = express();
    app.use((req, _res, next) => {
      req.context = {};
      next();
    });
    app.get(
      '/v1/stores/:storeId/protected',
      requireAuth,
      requireStoreMembership,
      (req, res) =>
        res.status(200).json({
          userId: req.context.userId,
          storeId: req.context.storeId,
          role: req.context.role,
        }),
    );
    app.use(errorHandler);

    const response = await request(app)
      .get(`/v1/stores/${storeId}/protected`)
      .set('authorization', `Bearer ${token}`)
      .expect(200);

    expect(response.body).toEqual({ userId, storeId, role: 'OWNER' });
  });
});
