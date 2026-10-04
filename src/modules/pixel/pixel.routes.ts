import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireRole, requireStoreMembership } from '../../middleware/store.middleware.js';
import {
  requireActiveSubscription,
  requireBillingEntitlement,
} from '../billing/billing.middleware.js';
import { pixelAttributionController } from './attribution/pixel-attribution.controller.js';
import { pixelBehaviorController } from './behavior/pixel-behavior.controller.js';
import { pixelEntityDetailController } from './behavior/pixel-entity-detail.controller.js';
import { pixelJourneyController } from './journey/pixel-journey.controller.js';
import { pixelHealthController } from './pixel-health.controller.js';
import { pixelController } from './pixel.controller.js';

export const pixelPublicRouter = Router();
pixelPublicRouter.post('/events', pixelController.ingest);
pixelPublicRouter.post('/events/browser', pixelController.browserSignals);

export const pixelStoreRouter = Router({ mergeParams: true });
pixelStoreRouter.use(requireAuth, requireStoreMembership);

// Installation/operational status stays visible for recovery even after a subscription expires.
pixelStoreRouter.get('/status', pixelController.status);
pixelStoreRouter.get('/health', requireRole('OWNER', 'ADMIN'), pixelHealthController.read);

pixelStoreRouter.use(requireActiveSubscription);

// Essentials includes the raw per-session evidence browser and individual session inspection.
pixelStoreRouter.get('/sessions', pixelJourneyController.sessions);
pixelStoreRouter.get('/sessions/:sessionId', pixelJourneyController.session);
// Pro connects those sessions into a pseudonymous multi-session visitor journey.
pixelStoreRouter.get(
  '/journeys/:anonymousVisitorId',
  requireBillingEntitlement('VISITOR_JOURNEYS'),
  pixelJourneyController.visitorJourney,
);

pixelStoreRouter.get('/analytics/overview', pixelBehaviorController.overview);
pixelStoreRouter.get('/analytics/products/batch', pixelEntityDetailController.productBatch);
pixelStoreRouter.get('/analytics/products/:productId/sources', pixelEntityDetailController.productSources);
pixelStoreRouter.get('/analytics/products/:productId', pixelEntityDetailController.product);
pixelStoreRouter.get('/analytics/products', pixelBehaviorController.products);
pixelStoreRouter.get('/analytics/collections/batch', pixelEntityDetailController.collectionBatch);
pixelStoreRouter.get('/analytics/collections/:collectionId/sources', pixelEntityDetailController.collectionSources);
pixelStoreRouter.get('/analytics/collections/:collectionId', pixelEntityDetailController.collection);
pixelStoreRouter.get('/analytics/collections', pixelBehaviorController.collections);
pixelStoreRouter.get('/analytics/landing-pages', pixelBehaviorController.landingPages);
pixelStoreRouter.get('/attribution/sources', pixelAttributionController.sources);
pixelStoreRouter.get('/attribution/meta-ads', pixelAttributionController.metaAds);
pixelStoreRouter.get(
  '/attribution/paths',
  requireBillingEntitlement('ADVANCED_ATTRIBUTION'),
  pixelAttributionController.paths,
);
pixelStoreRouter.get(
  '/attribution/mapping-evidence',
  requireBillingEntitlement('ADVANCED_ATTRIBUTION'),
  pixelAttributionController.mappingEvidence,
);

pixelStoreRouter.post('/install', requireRole('OWNER', 'ADMIN'), pixelController.install);
pixelStoreRouter.post(
  '/debug/validate',
  requireRole('OWNER', 'ADMIN'),
  pixelController.debugValidate,
);
