import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireRole, requireStoreMembership } from '../../middleware/store.middleware.js';
import { requireActiveSubscription } from '../billing/billing.middleware.js';
import { conversionDeliveryController } from './conversion-delivery.controller.js';
import { managedConversionSetupController } from './managed-conversion-setup.controller.js';

const ownerOrAdmin = requireRole('OWNER', 'ADMIN');

export const conversionDeliveryRouter = Router({ mergeParams: true });
conversionDeliveryRouter.use(requireAuth, requireStoreMembership, requireActiveSubscription);

conversionDeliveryRouter.get('/destinations', conversionDeliveryController.destinations);
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
