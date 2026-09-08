import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireRole, requireStoreMembership } from '../../middleware/store.middleware.js';
import { billingController } from './billing.controller.js';

const ownerOrAdmin = requireRole('OWNER', 'ADMIN');

export const billingRouter = Router({ mergeParams: true });
billingRouter.use(requireAuth, requireStoreMembership);
billingRouter.get('/', billingController.read);
billingRouter.get('/portal', ownerOrAdmin, billingController.portal);
billingRouter.post('/refresh', ownerOrAdmin, billingController.refresh);
billingRouter.patch('/plan', ownerOrAdmin, billingController.selectPlan);
billingRouter.patch('/ad-provider', ownerOrAdmin, billingController.selectAdProvider);
