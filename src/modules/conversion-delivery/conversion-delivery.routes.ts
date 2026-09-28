import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireRole, requireStoreMembership } from '../../middleware/store.middleware.js';
import { requireActiveSubscription } from '../billing/billing.middleware.js';
import { conversionDeliveryController } from './conversion-delivery.controller.js';

const ownerOrAdmin = requireRole('OWNER', 'ADMIN');

export const conversionDeliveryRouter = Router({ mergeParams: true });
conversionDeliveryRouter.use(requireAuth, requireStoreMembership, requireActiveSubscription);

conversionDeliveryRouter.get('/destinations', conversionDeliveryController.destinations);
conversionDeliveryRouter.get('/deliveries', conversionDeliveryController.deliveries);
conversionDeliveryRouter.put('/destinations', ownerOrAdmin, conversionDeliveryController.configure);
conversionDeliveryRouter.post(
  '/destinations/:destinationId/disable',
  ownerOrAdmin,
  conversionDeliveryController.disable,
);
