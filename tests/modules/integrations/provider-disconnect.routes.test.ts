import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';
const { disconnect, noop, billing } = vi.hoisted(() => ({
  disconnect: vi.fn(),
  noop: vi.fn(),
  billing: vi.fn(),
}));
vi.mock('../../../src/middleware/auth.middleware.js', () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock('../../../src/modules/billing/billing.middleware.js', () => ({
  requireAdProviderEntitlement: () => billing,
}));
vi.mock('../../../src/modules/meta/meta.controller.js', () => ({
  metaController: new Proxy(
    {},
    { get: (_target, key) => (key === 'disconnect' ? disconnect : noop) },
  ),
}));
vi.mock('../../../src/modules/tiktok/tiktok.controller.js', () => ({
  tiktokController: new Proxy(
    {},
    { get: (_target, key) => (key === 'disconnect' ? disconnect : noop) },
  ),
}));
import { metaStoreRouter } from '../../../src/modules/meta/meta.routes.js';
import { tiktokStoreRouter } from '../../../src/modules/tiktok/tiktok.routes.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';
const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function app(role: 'OWNER' | 'ADMIN' | 'MEMBER', member = true) {
  const result = express();
  result.use((req, _res, next) => {
    req.context = { userId: 'user-a', storeAccess: member ? [{ storeId, role }] : [] };
    next();
  });
  result.use('/stores/:storeId/integrations/meta', metaStoreRouter);
  result.use('/stores/:storeId/integrations/tiktok', tiktokStoreRouter);
  result.use(errorHandler);
  return result;
}
beforeEach(() => {
  disconnect
    .mockReset()
    .mockImplementation((req: Request, res: Response) =>
      res.json({ storeId: req.context.storeId }),
    );
  billing.mockReset().mockImplementation((_req: Request, res: Response) => res.sendStatus(402));
});
for (const provider of ['meta', 'tiktok']) {
  it.each(['OWNER', 'ADMIN'] as const)(
    `${provider}: permits %s to disconnect despite expired paid access`,
    async (role) => {
      const result = await request(app(role))
        .post(`/stores/${storeId}/integrations/${provider}/disconnect`)
        .expect(200);
      expect(result.body).toEqual({ storeId });
      expect(billing).not.toHaveBeenCalled();
    },
  );
  it(`${provider}: rejects members and another store before calling disconnect`, async () => {
    await request(app('MEMBER'))
      .post(`/stores/${storeId}/integrations/${provider}/disconnect`)
      .expect(403);
    await request(app('OWNER', false))
      .post(`/stores/${storeId}/integrations/${provider}/disconnect`)
      .expect(404);
    expect(disconnect).not.toHaveBeenCalled();
  });
}
