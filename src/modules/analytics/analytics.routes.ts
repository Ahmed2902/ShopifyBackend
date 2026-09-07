import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireStoreMembership } from '../../middleware/store.middleware.js';
import { adExposureController } from './ad-exposure.controller.js';
import { analyticsController } from './analytics.controller.js';
import { dashboardController } from './dashboard.controller.js';
import { tiktokMonitorController } from './tiktok-monitor.controller.js';

export const analyticsRouter = Router({ mergeParams: true });
analyticsRouter.use(requireAuth, requireStoreMembership);

analyticsRouter.get('/dashboard', dashboardController.read);
analyticsRouter.get('/overview', analyticsController.overview);
analyticsRouter.get('/products', analyticsController.products);
analyticsRouter.get('/products/:productId', analyticsController.product);
analyticsRouter.get('/product-ads', analyticsController.productAds);
analyticsRouter.get('/product-ads/:productId', analyticsController.productAdsProduct);
analyticsRouter.get('/ad-exposure', adExposureController.list);
analyticsRouter.get('/ad-exposure/:adId', adExposureController.detail);
analyticsRouter.get('/collections', analyticsController.collections);
analyticsRouter.get('/customers', analyticsController.customers);
analyticsRouter.get('/inventory', analyticsController.inventory);

analyticsRouter.get('/advertising', analyticsController.advertising);
analyticsRouter.get('/tiktok-monitor', tiktokMonitorController.read);
analyticsRouter.get('/campaigns', analyticsController.campaigns);
analyticsRouter.get('/campaigns/:campaignId', analyticsController.campaign);
analyticsRouter.get('/adsets', analyticsController.adSets);
analyticsRouter.get('/adsets/:adSetId', analyticsController.adSet);
analyticsRouter.get('/ads', analyticsController.ads);
analyticsRouter.get('/ads/:adId', analyticsController.ad);
analyticsRouter.get('/creatives', analyticsController.creatives);
analyticsRouter.get('/creatives/:creativeId', analyticsController.creative);
