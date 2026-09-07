import express, { type NextFunction, type Request, type Response } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { StoreAccessClaim } from '../../../src/types/auth.js';

const { install, debugValidate, noop } = vi.hoisted(() => ({
  install: vi.fn(),
  debugValidate: vi.fn(),
  noop: vi.fn(),
}));

vi.mock('../../../src/middleware/auth.middleware.js', () => ({
  requireAuth: (_req: Request, _res: Response, next: NextFunction) => next(),
}));

vi.mock('../../../src/modules/pixel/pixel.controller.js', () => ({
  pixelController: {
    ingest: noop,
    status: noop,
    install,
    debugValidate,
  },
}));

vi.mock('../../../src/modules/pixel/journey/pixel-journey.controller.js', () => ({
  pixelJourneyController: {
    sessions: noop,
    session: noop,
    visitorJourney: noop,
  },
}));

vi.mock('../../../src/modules/pixel/behavior/pixel-behavior.controller.js', () => ({
  pixelBehaviorController: {
    overview: noop,
    products: noop,
    collections: noop,
    landingPages: noop,
  },
}));

vi.mock('../../../src/modules/pixel/attribution/pixel-attribution.controller.js', () => ({
  pixelAttributionController: {
    sources: noop,
    metaAds: noop,
    paths: noop,
    mappingEvidence: noop,
  },
}));

import { errorHandler } from '../../../src/middleware/error-handler.js';
import { pixelStoreRouter } from '../../../src/modules/pixel/pixel.routes.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function buildApp(role: StoreAccessClaim['role']) {
  const app = express();
  app.use((req, _res, next) => {
    req.context = {
      userId: 'route-authz-user',
      storeAccess: [{ storeId, role }],
    };
    next();
  });
  app.use('/stores/:storeId/pixel', pixelStoreRouter);
  app.use(errorHandler);
  return app;
}

beforeEach(() => {
  install.mockReset();
  debugValidate.mockReset();
  noop.mockReset();
  install.mockImplementation((_req: Request, res: Response) => res.status(204).send());
  debugValidate.mockImplementation((_req: Request, res: Response) => res.status(204).send());
  noop.mockImplementation((_req: Request, res: Response) => res.status(204).send());
});

describe('production pixel route authorization', () => {
  it.each([
    ['/install', install],
    ['/debug/validate', debugValidate],
  ] as const)('blocks MEMBER from the real POST %s route before the controller runs', async (path, handler) => {
    const response = await request(buildApp('MEMBER')).post(`/stores/${storeId}/pixel${path}`).expect(403);

    expect(response.body.error).toMatchObject({ code: 'FORBIDDEN' });
    expect(handler).not.toHaveBeenCalled();
  });

  it.each(['OWNER', 'ADMIN'] as const)('allows %s through privileged production pixel routes', async (role) => {
    await request(buildApp(role)).post(`/stores/${storeId}/pixel/install`).expect(204);
    await request(buildApp(role)).post(`/stores/${storeId}/pixel/debug/validate`).expect(204);

    expect(install).toHaveBeenCalledTimes(1);
    expect(debugValidate).toHaveBeenCalledTimes(1);
  });
});
