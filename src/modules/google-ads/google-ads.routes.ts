import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { requireRole, requireStoreMembership } from '../../middleware/store.middleware.js';
import { requireActiveSubscription, requireAdProviderEntitlement } from '../billing/billing.middleware.js';
import { googleAdsController } from './google-ads.controller.js';

const ownerOrAdmin = requireRole('OWNER', 'ADMIN');

export const googleAdsRouter = Router();
googleAdsRouter.get('/callback', googleAdsController.completeInstall);

export const googleAdsStoreRouter = Router({ mergeParams: true });
googleAdsStoreRouter.use(requireAuth, requireStoreMembership);
googleAdsStoreRouter.get('/status', googleAdsController.status);
googleAdsStoreRouter.post('/disconnect', ownerOrAdmin, googleAdsController.disconnect);
googleAdsStoreRouter.use(requireActiveSubscription, requireAdProviderEntitlement('GOOGLE_ADS'));
googleAdsStoreRouter.get('/customers', ownerOrAdmin, googleAdsController.customers);
googleAdsStoreRouter.post('/install', ownerOrAdmin, googleAdsController.startInstall);
googleAdsStoreRouter.post('/configure', ownerOrAdmin, googleAdsController.configure);
googleAdsStoreRouter.post('/sync', ownerOrAdmin, googleAdsController.sync);
