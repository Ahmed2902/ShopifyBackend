import { logger } from './lib/logger.js';
import { PollingWorker } from './lib/polling-worker.js';
import { pixelService } from './modules/pixel/pixel.service.js';
import { reconciliationService } from './modules/reconciliation/reconciliation.service.js';
import { shopifyService } from './modules/shopify/shopify.service.js';
import { tiktokWebhookService } from './modules/tiktok/webhook/tiktok-webhook.service.js';

const shopifyWebhookWorker = new PollingWorker(
  1_000,
  async () => {
    const result = await shopifyService.processWebhookQueue(20);
    if (result.claimed > 0) logger.debug(result, 'Processed Shopify webhook queue batch');
  },
  'Shopify webhook worker failed',
);

const tiktokWebhookWorker = new PollingWorker(
  2_000,
  async () => {
    const result = await tiktokWebhookService.processDue();
    if (result.claimed > 0) logger.debug(result, 'Processed TikTok webhook queue batch');
  },
  'TikTok webhook worker failed',
);

const reconciliationWorker = new PollingWorker(
  60_000,
  async () => {
    const result = await reconciliationService.processDue(10);
    if (result.claimed > 0) logger.info(result, 'Processed scheduled reconciliation batch');
  },
  'Scheduled reconciliation worker failed',
);

const pixelRetentionWorker = new PollingWorker(
  60_000,
  async () => {
    const result = await pixelService.cleanupExpiredEvents();
    if (result.deleted > 0) logger.info(result, 'Deleted expired raw storefront events');
  },
  'Stride Pixel retention cleanup failed',
);

const workers = [
  shopifyWebhookWorker,
  tiktokWebhookWorker,
  reconciliationWorker,
  pixelRetentionWorker,
];

export function startWorkers(): void {
  for (const worker of workers) worker.start();
}

export async function stopWorkers(): Promise<void> {
  await Promise.all(workers.map((worker) => worker.stop()));
}
