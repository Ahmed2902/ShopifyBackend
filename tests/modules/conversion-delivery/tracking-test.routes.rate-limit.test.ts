import { randomUUID } from 'node:crypto';
import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { handler } = vi.hoisted(() => ({ handler: vi.fn() }));
vi.mock('../../../src/middleware/auth.middleware.js', () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock('../../../src/modules/billing/billing.middleware.js', () => ({
  requireActiveSubscription: (_req: Request, _res: Response, next: NextFunction) => next(),
}));
vi.mock('../../../src/modules/conversion-delivery/conversion-delivery.controller.js', () => ({
  conversionDeliveryController: {
    testDestination: handler,
    routingPreview: handler,
    testOrders: handler,
    testPurchase: handler,
    testResult: handler,
    destinations: handler,
    customerJourney: handler,
    signalHealth: handler,
    acquisition: handler,
    updateSignals: handler,
    deliveries: handler,
    configure: handler,
    disable: handler,
  },
}));
vi.mock('../../../src/modules/conversion-delivery/managed-conversion-setup.controller.js', () => ({
  managedConversionSetupController: { options: handler, enable: handler },
}));

import { conversionDeliveryRouter } from '../../../src/modules/conversion-delivery/conversion-delivery.routes.js';
import { errorHandler } from '../../../src/middleware/error-handler.js';

const counters = new Map<string, number>();
function app(storeId: string, role: 'OWNER' | 'MEMBER' = 'OWNER') {
  const instance = express();
  instance.use((req, _res, next) => {
    req.context = { userId: 'user', storeAccess: [{ storeId, role }] };
    next();
  });
  instance.use('/stores/:storeId/conversion-delivery', conversionDeliveryRouter);
  instance.use(errorHandler);
  return instance;
}
const path = (storeId: string, destination: string, checkout = false) =>
  `/stores/${storeId}/conversion-delivery/destinations/${destination}/${checkout ? 'test-purchase' : 'test'}`;

beforeEach(() => {
  counters.clear();
  handler.mockReset().mockImplementation((_req: Request, res: Response) => res.sendStatus(204));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init: RequestInit) => {
      const command = JSON.parse(String(init.body)) as string[];
      const key = command[3];
      const count = (counters.get(key) ?? 0) + 1;
      counters.set(key, count);
      return new globalThis.Response(JSON.stringify({ result: [count, 60_000] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
});
afterEach(() => vi.unstubAllGlobals());

describe('tracking test request budgets', () => {
  it('allows three connection checks followed immediately by a three-channel checkout test', async () => {
    const storeId = randomUUID();
    const instance = app(storeId);
    for (const destination of ['meta', 'tiktok', 'google']) {
      await request(instance).post(path(storeId, destination)).expect(204);
    }
    const responses = await Promise.all(
      ['meta', 'tiktok', 'google'].map((destination) =>
        request(instance).post(path(storeId, destination, true)),
      ),
    );
    expect(responses.map((response) => response.status)).toEqual([204, 204, 204]);
    expect(handler).toHaveBeenCalledTimes(6);
  });

  it('keeps a three-request per-destination limit without exhausting another channel', async () => {
    const storeId = randomUUID();
    const instance = app(storeId);
    for (let i = 0; i < 3; i++)
      await request(instance)
        .post(path(storeId, 'meta', true))
        .expect(204);
    const blocked = await request(instance)
      .post(path(storeId, 'meta', true))
      .expect(429);
    expect(blocked.body.error.code).toBe('RATE_LIMITED');
    expect(blocked.headers['retry-after']).toBeDefined();
    await request(instance)
      .post(path(storeId, 'tiktok', true))
      .expect(204);
    await request(instance).post(path(storeId, 'meta')).expect(204);
  });

  it.each([false, true])(
    'bounds rotated destination IDs per store (checkout=%s)',
    async (checkout) => {
      const storeId = randomUUID();
      const instance = app(storeId);
      for (let i = 0; i < 9; i++)
        await request(instance)
          .post(path(storeId, `destination-${i}`, checkout))
          .expect(204);
      await request(instance)
        .post(path(storeId, 'another-destination', checkout))
        .expect(429);
      expect(handler).toHaveBeenCalledTimes(9);
    },
  );

  it('does not share budgets across stores using the same destination identifier', async () => {
    const first = randomUUID();
    const second = randomUUID();
    for (let i = 0; i < 3; i++)
      await request(app(first))
        .post(path(first, 'meta', true))
        .expect(204);
    await request(app(first))
      .post(path(first, 'meta', true))
      .expect(429);
    await request(app(second))
      .post(path(second, 'meta', true))
      .expect(204);
  });

  it('rejects members before consuming the test budget or invoking a controller', async () => {
    const storeId = randomUUID();
    await request(app(storeId, 'MEMBER'))
      .post(path(storeId, 'meta', true))
      .expect(403);
    expect(counters.size).toBe(0);
    expect(handler).not.toHaveBeenCalled();
  });

  it('fails closed when the shared limiter is unavailable', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Redis unavailable')));
    const storeId = randomUUID();
    await request(app(storeId))
      .post(path(storeId, 'meta', true))
      .expect(503);
    expect(handler).not.toHaveBeenCalled();
  });
});
