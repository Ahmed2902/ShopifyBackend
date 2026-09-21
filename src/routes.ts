import { Router } from 'express';
import { analyticsRouter } from './modules/analytics/analytics.routes.js';
import { authRouter } from './modules/auth/auth.routes.js';
import { billingRouter } from './modules/billing/billing.routes.js';
import { intelligenceRouter } from './modules/intelligence/intelligence.routes.js';
import { integrationRouter } from './modules/integrations/integration.routes.js';
import { mcpOAuthRouter } from './modules/mcp/mcp-oauth.routes.js';
import { mcpRouter } from './modules/mcp/mcp.routes.js';
import { metaRouter, metaStoreRouter } from './modules/meta/meta.routes.js';
import { pixelPublicRouter, pixelStoreRouter } from './modules/pixel/pixel.routes.js';
import { shopifyRouter, shopifyStoreRouter } from './modules/shopify/shopify.routes.js';
import { storeRouter } from './modules/stores/store.routes.js';
import { tiktokRouter, tiktokStoreRouter } from './modules/tiktok/tiktok.routes.js';
import { healthRouter } from './routes/health.routes.js';

const router = Router();

router.get('/', (_req, res) => {
  res.setHeader('cache-control', 'no-store');
  const revision = process.env.VERCEL_GIT_COMMIT_SHA ?? process.env.GIT_COMMIT_SHA;
  if (revision) res.setHeader('x-stride-revision', revision);

  res.status(200).json({
    service: 'stride-api',
    status: 'ok',
    api: '/v1',
    mcp: '/mcp',
    health: {
      live: '/health/live',
      ready: '/health/ready',
    },
  });
});

router.use(mcpOAuthRouter);
router.use(mcpRouter);
router.use('/health', healthRouter);
router.use('/v1/auth', authRouter);
router.use('/v1/pixel', pixelPublicRouter);
router.use('/v1/integrations/shopify', shopifyRouter);
router.use('/v1/integrations/meta', metaRouter);
router.use('/v1/integrations/tiktok', tiktokRouter);
router.use('/v1/stores/:storeId/billing', billingRouter);
router.use('/v1/stores/:storeId/integrations/shopify', shopifyStoreRouter);
router.use('/v1/stores/:storeId/integrations/meta', metaStoreRouter);
router.use('/v1/stores/:storeId/integrations/tiktok', tiktokStoreRouter);
router.use('/v1/stores/:storeId/integrations', integrationRouter);
router.use('/v1/stores/:storeId/intelligence', intelligenceRouter);
router.use('/v1/stores/:storeId/analytics', analyticsRouter);
router.use('/v1/stores/:storeId/pixel', pixelStoreRouter);
router.use('/v1/stores', storeRouter);

export { router };
