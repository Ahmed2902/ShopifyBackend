import { Router } from 'express';
import { storeRouter } from './modules/stores/store.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { integrationRouter } from './modules/integrations/integration.routes.js';
import { shopifyRouter, shopifyStoreRouter } from './modules/shopify/shopify.routes.js';
import { healthRouter } from './routes/health.routes.js';

const router = Router();

router.use('/health', healthRouter);
router.use('/v1/auth', authRouter);
router.use('/v1/integrations/shopify', shopifyRouter);
router.use('/v1/stores/:storeId/integrations/shopify', shopifyStoreRouter);
router.use('/v1/stores/:storeId/integrations', integrationRouter);
router.use('/v1/stores', storeRouter);

export { router };
