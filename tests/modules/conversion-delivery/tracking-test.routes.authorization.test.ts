import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
const { testDestination, noop } = vi.hoisted(() => ({ testDestination: vi.fn(), noop: vi.fn() }));
vi.mock('../../../src/middleware/auth.middleware.js', () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock('../../../src/modules/billing/billing.middleware.js', () => ({
  requireActiveSubscription: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock('../../../src/middleware/rate-limit.middleware.js', () => ({
  rateLimit: () => (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock('../../../src/modules/conversion-delivery/conversion-delivery.controller.js', () => ({
  conversionDeliveryController: {
    testDestination,
    routingPreview: noop,
    testOrders: noop,
    testPurchase: noop,
    testResult: noop,
    destinations: noop,
    customerJourney: noop,
    signalHealth: noop,
    acquisition: noop,
    updateSignals: noop,
    deliveries: noop,
    configure: noop,
    disable: noop,
  },
}));
vi.mock('../../../src/modules/conversion-delivery/managed-conversion-setup.controller.js', () => ({
  managedConversionSetupController: { options: noop, enable: noop },
}));
import { conversionDeliveryRouter } from '../../../src/modules/conversion-delivery/conversion-delivery.routes.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';
const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
function app(role: 'OWNER' | 'ADMIN' | 'MEMBER', membership = true) {
  const app = express();
  app.use((req, _res, next) => {
    req.context = { userId: 'user', storeAccess: membership ? [{ storeId, role }] : [] };
    next();
  });
  app.use('/stores/:storeId/conversion-delivery', conversionDeliveryRouter);
  app.use(errorHandler);
  return app;
}
beforeEach(() => {
  testDestination
    .mockReset()
    .mockImplementation((_req: Request, res: Response) => res.sendStatus(204));
});
describe('tracking test route authorization', () => {
  it('blocks a member before invoking the external test', async () => {
    await request(app('MEMBER'))
      .post(`/stores/${storeId}/conversion-delivery/destinations/d/test`)
      .expect(403);
    expect(testDestination).not.toHaveBeenCalled();
  });
  it('blocks a store without membership', async () => {
    await request(app('OWNER', false))
      .post(`/stores/${storeId}/conversion-delivery/destinations/d/test`)
      .expect(404);
    expect(testDestination).not.toHaveBeenCalled();
  });
  it.each(['OWNER', 'ADMIN'] as const)('allows %s', async (role) => {
    await request(app(role))
      .post(`/stores/${storeId}/conversion-delivery/destinations/d/test`)
      .expect(204);
    expect(testDestination).toHaveBeenCalledOnce();
  });
});
