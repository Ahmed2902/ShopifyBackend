import { Router } from 'express';
import { analyticsRouter } from './modules/analytics/analytics.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { intelligenceRouter } from './modules/intelligence/intelligence.routes.js';
import { integrationRouter } from './modules/integrations/integration.routes.js';
import { metaRouter, metaStoreRouter } from './modules/meta/meta.routes.js';
import { shopifyRouter, shopifyStoreRouter } from './modules/shopify/shopify.routes.js';
import { storeRouter } from './modules/stores/store.routes.js';
import { tiktokRouter, tiktokStoreRouter } from './modules/tiktok/tiktok.routes.js';
import { healthRouter } from './routes/health.routes.js';

const router = Router();

router.use('/health', healthRouter);
router.use('/v1/auth', authRouter);
router.use('/v1/integrations/shopify', shopifyRouter);
router.use('/v1/integrations/meta', metaRouter);
router.use('/v1/integrations/tiktok', tiktokRouter);
router.use('/v1/stores/:storeId/integrations/shopify', shopifyStoreRouter);
router.use('/v1/stores/:storeId/integrations/meta', metaStoreRouter);
router.use('/v1/stores/:storeId/integrations/tiktok', tiktokStoreRouter);
router.use('/v1/stores/:storeId/integrations', integrationRouter);
router.use('/v1/stores/:storeId/intelligence', intelligenceRouter);
router.use('/v1/stores/:storeId/analytics', analyticsRouter);
router.use('/v1/stores', storeRouter);

export { router };
