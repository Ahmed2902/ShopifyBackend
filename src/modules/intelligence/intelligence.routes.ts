import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireRole, requireStoreMembership } from '../../middleware/store.middleware.js';
import { requireActiveSubscription } from '../billing/billing.middleware.js';
import { intelligenceController } from './intelligence.controller.js';

const ownerOrAdmin = requireRole('OWNER', 'ADMIN');

export const intelligenceRouter = Router({ mergeParams: true });
intelligenceRouter.use(requireAuth, requireStoreMembership, requireActiveSubscription);

intelligenceRouter.get('/snapshot', intelligenceController.snapshot);
intelligenceRouter.get('/settings', intelligenceController.settings);
intelligenceRouter.patch(
  '/settings/inventory',
  ownerOrAdmin,
  intelligenceController.updateInventoryMode,
);
intelligenceRouter.patch(
  '/recommendations/lifecycle',
  intelligenceController.updateRecommendationLifecycle,
);
