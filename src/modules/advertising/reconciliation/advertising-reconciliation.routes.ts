import { Router } from 'express';
import { requireAuth } from '../../../middleware/auth.middleware.js';
import { requireRole, requireStoreMembership } from '../../../middleware/store.middleware.js';
import { advertisingReconciliationController } from './advertising-reconciliation.controller.js';

const ownerOrAdmin = requireRole('OWNER', 'ADMIN');

export const advertisingReconciliationRouter = Router({ mergeParams: true });
advertisingReconciliationRouter.use(requireAuth, requireStoreMembership);
advertisingReconciliationRouter.get('/', advertisingReconciliationController.status);
advertisingReconciliationRouter.post('/:provider/sync', ownerOrAdmin, advertisingReconciliationController.sync);
