import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, expect, it, vi } from 'vitest';
const { apply, audit, manual, entitled } = vi.hoisted(() => ({
  apply: vi.fn(),
  audit: vi.fn(),
  manual: vi.fn(),
  entitled: { value: true },
}));
vi.mock('../../../src/middleware/auth.middleware.js', () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock('../../../src/modules/billing/billing.middleware.js', () => ({
  requireAdProviderEntitlement: () => (_req: Request, res: Response, next: NextFunction) =>
    entitled.value ? next() : res.sendStatus(403),
}));
vi.mock('../../../src/modules/tiktok/tracking/tiktok-tracking.controller.js', () => ({
  tiktokTrackingController: { apply, audit, manual },
}));
import { tiktokStoreRouter } from '../../../src/modules/tiktok/tiktok.routes.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';
const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function app(role: 'OWNER' | 'ADMIN' | 'MEMBER', member = true) {
  const a = express();
  a.use((req, _res, next) => {
    req.context = { userId: 'user', storeAccess: member ? [{ storeId, role }] : [] };
    next();
  });
  a.use('/stores/:storeId/integrations/tiktok', tiktokStoreRouter);
  a.use(errorHandler);
  return a;
}
beforeEach(() => {
  entitled.value = true;
  for (const fn of [apply, audit, manual])
    fn.mockReset().mockImplementation((_req: Request, res: Response) => res.sendStatus(204));
});
it.each(['OWNER', 'ADMIN'] as const)('allows %s to install tracking', async (role) => {
  await request(app(role))
    .post(`/stores/${storeId}/integrations/tiktok/tracking/apply`)
    .expect(204);
  expect(apply).toHaveBeenCalledOnce();
});
it('blocks members and non-members before tracking reads or writes', async () => {
  await request(app('MEMBER'))
    .post(`/stores/${storeId}/integrations/tiktok/tracking/apply`)
    .expect(403);
  await request(app('OWNER', false))
    .get(`/stores/${storeId}/integrations/tiktok/tracking`)
    .expect(404);
  expect(apply).not.toHaveBeenCalled();
  expect(audit).not.toHaveBeenCalled();
});
it('blocks tracking mutations without TikTok entitlement', async () => {
  entitled.value = false;
  await request(app('OWNER'))
    .post(`/stores/${storeId}/integrations/tiktok/tracking/apply`)
    .expect(403);
  expect(apply).not.toHaveBeenCalled();
});
