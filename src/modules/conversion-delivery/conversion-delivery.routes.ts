import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireRole, requireStoreMembership } from '../../middleware/store.middleware.js';
import { requireActiveSubscription } from '../billing/billing.middleware.js';
import { conversionDeliveryController } from './conversion-delivery.controller.js';
import { managedConversionSetupController } from './managed-conversion-setup.controller.js';
import { rateLimit } from '../../middleware/rate-limit.middleware.js';

const ownerOrAdmin = requireRole('OWNER', 'ADMIN');

export const conversionDeliveryRouter = Router({ mergeParams: true });
conversionDeliveryRouter.use(requireAuth, requireStoreMembership, requireActiveSubscription);

conversionDeliveryRouter.get(
  '/orders/:orderId/routing',
  conversionDeliveryController.routingPreview,
);
conversionDeliveryRouter.get('/destinations', conversionDeliveryController.destinations);
conversionDeliveryRouter.get(
  '/test-orders',
  ownerOrAdmin,
  rateLimit({
    name: 'tracking-orders',
    max: 10,
    windowMs: 60_000,
    key: (req) => req.context.storeId!,
  }),
  conversionDeliveryController.testOrders,
);
conversionDeliveryRouter.get(
  '/tests/:testId',
  ownerOrAdmin,
  conversionDeliveryController.testResult,
);
// Allow a three-channel review run without connection checks consuming the
// checkout budget. Bound both repeated destination tests and rotated-ID bursts.
conversionDeliveryRouter.post(
  '/destinations/:destinationId/test-purchase',
  ownerOrAdmin,
  rateLimit({
    name: 'tracking-checkout-test-store',
    max: 9,
    windowMs: 60_000,
    key: (req) => req.context.storeId!,
  }),
  rateLimit({
    name: 'tracking-checkout-test-destination',
    preserveStricterHeaders: true,
    max: 3,
    windowMs: 60_000,
    key: (req) => JSON.stringify([req.context.storeId, req.params.destinationId]),
  }),
  conversionDeliveryController.testPurchase,
);

conversionDeliveryRouter.post(
  '/destinations/:destinationId/test',
  ownerOrAdmin,
  rateLimit({
    name: 'tracking-connection-test-store',
    max: 9,
    windowMs: 60_000,
    key: (req) => req.context.storeId!,
  }),
  rateLimit({
    name: 'tracking-connection-test-destination',
    preserveStricterHeaders: true,
    max: 3,
    windowMs: 60_000,
    key: (req) => JSON.stringify([req.context.storeId, req.params.destinationId]),
  }),
  conversionDeliveryController.testDestination,
);
conversionDeliveryRouter.get(
  '/orders/:orderId/journey',
  conversionDeliveryController.customerJourney,
);
conversionDeliveryRouter.get('/signal-health', conversionDeliveryController.signalHealth);
conversionDeliveryRouter.get('/acquisition', conversionDeliveryController.acquisition);
conversionDeliveryRouter.patch(
  '/destinations/:destinationId/signals',
  ownerOrAdmin,
  conversionDeliveryController.updateSignals,
);
conversionDeliveryRouter.get('/deliveries', conversionDeliveryController.deliveries);
conversionDeliveryRouter.get(
  '/setup-options',
  ownerOrAdmin,
  managedConversionSetupController.options,
);
conversionDeliveryRouter.put('/destinations', ownerOrAdmin, conversionDeliveryController.configure);
conversionDeliveryRouter.post(
  '/managed-destinations',
  ownerOrAdmin,
  managedConversionSetupController.enable,
);
conversionDeliveryRouter.post(
  '/destinations/:destinationId/disable',
  ownerOrAdmin,
  conversionDeliveryController.disable,
);
