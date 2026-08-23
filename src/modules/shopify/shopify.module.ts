import { logger } from '../../lib/logger.js';
import { PollingWorker } from '../../lib/polling-worker.js';
import { integrationService } from '../integrations/integration.module.js';
import { ShopifyOrderRepository } from './order/shopify-order.repository.js';
import { ShopifyMetricsRepository } from './read/shopify-metrics.repository.js';
import { ShopifyReadRepository } from './read/shopify-read.repository.js';
import { ShopifyReadService } from './read/shopify-read.service.js';
import { ShopifyRepository } from './shopify.repository.js';
import { ShopifyService } from './shopify.service.js';

export const shopifyService = new ShopifyService(
  new ShopifyRepository(),
  integrationService,
  new ShopifyOrderRepository(),
);

export const shopifyReadService = new ShopifyReadService(
  new ShopifyReadRepository(),
  new ShopifyMetricsRepository(),
);

export const shopifyWebhookWorker = new PollingWorker(
  1_000,
  async () => {
    const result = await shopifyService.processWebhookQueue(20);
    if (result.claimed > 0) logger.debug(result, 'Processed Shopify webhook queue batch');
  },
  'Shopify webhook worker failed',
);
