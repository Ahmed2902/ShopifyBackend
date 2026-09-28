import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireRole, requireStoreMembership } from '../../middleware/store.middleware.js';
import { conversionDeliveryController } from './conversion-delivery.controller.js';

const ownerOrAdmin = requireRole('OWNER', 'ADMIN');

export const conversionDeliveryRouter = Router({ mergeParams: true });
conversionDeliveryRouter.use(requireAuth, requireStoreMembership);

// Read/pause remain reachable after plan expiry so merchants can diagnose or safely stop delivery.
conversionDeliveryRouter.get('/destinations', conversionDeliveryController.destinations);
conversionDeliveryRouter.get('/deliveries', conversionDeliveryController.deliveries);
conversionDeliveryRouter.post(
  '/destinations/:destinationId/pause',
  ownerOrAdmin,
  conversionDeliveryController.pauseDestination,
);

// The service re-checks the Pro entitlement and selected provider account before every mutation.
conversionDeliveryRouter.put(
  '/destinations',
  ownerOrAdmin,
  conversionDeliveryController.configureDestination,
);
conversionDeliveryRouter.post(
  '/destinations/:destinationId/activate',
  ownerOrAdmin,
  conversionDeliveryController.activateDestination,
);
conversionDeliveryRouter.post(
  '/deliveries/:deliveryId/retry',
  ownerOrAdmin,
  conversionDeliveryController.retryDelivery,
);
