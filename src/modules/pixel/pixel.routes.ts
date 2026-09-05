import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireRole, requireStoreMembership } from '../../middleware/store.middleware.js';
import { pixelAttributionController } from './attribution/pixel-attribution.controller.js';
import { pixelBehaviorController } from './behavior/pixel-behavior.controller.js';
import { pixelJourneyController } from './journey/pixel-journey.controller.js';
import { pixelController } from './pixel.controller.js';

export const pixelPublicRouter = Router();
pixelPublicRouter.post('/events', pixelController.ingest);

export const pixelStoreRouter = Router({ mergeParams: true });
pixelStoreRouter.use(requireAuth, requireStoreMembership);
pixelStoreRouter.get('/status', pixelController.status);
pixelStoreRouter.get('/sessions', pixelJourneyController.sessions);
pixelStoreRouter.get('/sessions/:sessionId', pixelJourneyController.session);
pixelStoreRouter.get('/journeys/:anonymousVisitorId', pixelJourneyController.visitorJourney);
pixelStoreRouter.get('/analytics/overview', pixelBehaviorController.overview);
pixelStoreRouter.get('/analytics/products', pixelBehaviorController.products);
pixelStoreRouter.get('/analytics/collections', pixelBehaviorController.collections);
pixelStoreRouter.get('/analytics/landing-pages', pixelBehaviorController.landingPages);
pixelStoreRouter.get('/attribution/sources', pixelAttributionController.sources);
pixelStoreRouter.get('/attribution/meta-ads', pixelAttributionController.metaAds);
pixelStoreRouter.get('/attribution/paths', pixelAttributionController.paths);
pixelStoreRouter.get('/attribution/mapping-evidence', pixelAttributionController.mappingEvidence);
pixelStoreRouter.post('/install', requireRole('OWNER', 'ADMIN'), pixelController.install);
pixelStoreRouter.post(
  '/debug/validate',
  requireRole('OWNER', 'ADMIN'),
  pixelController.debugValidate,
);
