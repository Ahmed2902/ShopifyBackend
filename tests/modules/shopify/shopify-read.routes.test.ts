import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';

const passthrough = (_req: Request, _res: Response, next: NextFunction) => next();

vi.mock('../../../src/modules/billing/billing.middleware.js', () => ({
  requireActiveSubscription: passthrough,
  requireBillingEntitlement: () => passthrough,
  requireAdProviderEntitlement: () => passthrough,
}));

import { app } from '../../../src/app.js';
import { issueAccessToken } from '../../../src/modules/auth/auth.utils.js';

const readPaths = (storeId: string) => [
  `/v1/stores/${storeId}/integrations/shopify/status`,
  `/v1/stores/${storeId}/integrations/shopify/products`,
  `/v1/stores/${storeId}/integrations/shopify/inventory`,
  `/v1/stores/${storeId}/integrations/shopify/locations`,
  `/v1/stores/${storeId}/integrations/shopify/orders`,
];

describe('Shopify frontend read routes', () => {
  it('requires authentication on every collection/status read endpoint', async () => {
    const storeId = randomUUID();

    for (const path of readPaths(storeId)) {
      const response = await request(app).get(path);
      expect(response.status, path).toBe(401);
      expect(response.body.error.code, path).toBe('UNAUTHORIZED');
    }
  });

  it('hides stores that are not present in the authenticated token', async () => {
    const requestedStoreId = randomUUID();
    const otherStoreId = randomUUID();
    const token = await issueAccessToken(randomUUID(), [
      { storeId: otherStoreId, role: 'OWNER' },
    ]);

    const response = await request(app)
      .get(`/v1/stores/${requestedStoreId}/integrations/shopify/products`)
      .set('authorization', `Bearer ${token}`);

    expect(response.status).toBe(404);
    expect(response.body.error.code).toBe('STORE_NOT_FOUND');
  });

  it('allows MEMBER store access to read endpoints without requiring an admin role', async () => {
    const storeId = randomUUID();
    const token = await issueAccessToken(randomUUID(), [{ storeId, role: 'MEMBER' }]);

    const response = await request(app)
      .get(`/v1/stores/${storeId}/integrations/shopify/products`)
      .set('authorization', `Bearer ${token}`);

    expect(response.status).toBe(200);
    expect(response.body).toEqual({ items: [], page: 1, limit: 50, total: 0, hasMore: false });
  });

  it('keeps write/sync operations owner-or-admin only after shared read middleware', async () => {
    const storeId = randomUUID();
    const token = await issueAccessToken(randomUUID(), [{ storeId, role: 'MEMBER' }]);

    const response = await request(app)
      .post(`/v1/stores/${storeId}/integrations/shopify/sync`)
      .set('authorization', `Bearer ${token}`);

    expect(response.status).toBe(403);
    expect(response.body.error.code).toBe('FORBIDDEN');
  });
});
