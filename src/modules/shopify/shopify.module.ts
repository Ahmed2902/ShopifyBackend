import { IntegrationRepository } from '../integrations/integration.repository.js';
import { IntegrationService } from '../integrations/integration.service.js';
import { ShopifyOrderRepository } from './order/shopify-order.repository.js';
import { ShopifyRepository } from './shopify.repository.js';
import { ShopifyService } from './shopify.service.js';
import { ShopifyWebhookWorker } from './webhook/shopify-webhook.worker.js';

const integrationService = new IntegrationService(new IntegrationRepository());

export const shopifyService = new ShopifyService(
  new ShopifyRepository(),
  integrationService,
  new ShopifyOrderRepository(),
);

export const shopifyWebhookWorker = new ShopifyWebhookWorker(shopifyService);
