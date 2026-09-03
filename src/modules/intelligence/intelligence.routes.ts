import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireRole, requireStoreMembership } from '../../middleware/store.middleware.js';
import { intelligenceController } from './intelligence.controller.js';

const ownerOrAdmin = requireRole('OWNER', 'ADMIN');

export const intelligenceRouter = Router({ mergeParams: true });
intelligenceRouter.use(requireAuth, requireStoreMembership);

intelligenceRouter.get('/recommendations', intelligenceController.recommendations);
intelligenceRouter.get('/recommendations/:id', intelligenceController.recommendation);
intelligenceRouter.patch(
  '/recommendations/:id/status',
  intelligenceController.updateRecommendationStatus,
);
intelligenceRouter.get('/settings', intelligenceController.settings);
intelligenceRouter.get('/data-quality', intelligenceController.dataQuality);

intelligenceRouter.post('/evaluate', ownerOrAdmin, intelligenceController.evaluate);
intelligenceRouter.patch(
  '/settings/inventory',
  ownerOrAdmin,
  intelligenceController.updateInventoryMode,
);
