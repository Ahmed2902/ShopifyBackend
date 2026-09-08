import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireRole, requireStoreMembership } from '../../middleware/store.middleware.js';
import { billingController } from './billing.controller.js';

export const billingRouter = Router({ mergeParams: true });
billingRouter.use(requireAuth, requireStoreMembership);
billingRouter.get('/', billingController.read);
billingRouter.patch('/plan', requireRole('OWNER', 'ADMIN'), billingController.selectPlan);
