import { Router } from 'express';
import { requireAuth } from '../../middleware/auth.middleware.js';
import { ShopifyController } from './shopify.controller.js';
import { ShopifyRepository } from './shopify.repository.js';
import { ShopifyService } from './shopify.service.js';

const service = new ShopifyService(new ShopifyRepository());
const controller = new ShopifyController(service);

export const shopifyRouter = Router();

shopifyRouter.post('/install', requireAuth, controller.install);
shopifyRouter.get('/callback', controller.callback);
