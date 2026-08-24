import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireStoreMembership } from '../../middleware/store.middleware.js';
import { intelligenceController } from './intelligence.controller.js';

export const intelligenceRouter = Router({ mergeParams: true });
intelligenceRouter.use(requireAuth, requireStoreMembership);
intelligenceRouter.get('/recommendations', intelligenceController.recommendations);
