import { logger } from './lib/logger.js';
import { PollingWorker } from './lib/polling-worker.js';
import { reconciliationService } from './modules/reconciliation/reconciliation.service.js';
import { shopifyService } from './modules/shopify/shopify.service.js';

const shopifyWebhookWorker = new PollingWorker(
  1_000,
  async () => {
    const result = await shopifyService.processWebhookQueue(20);
    if (result.claimed > 0) logger.debug(result, 'Processed Shopify webhook queue batch');
  },
  'Shopify webhook worker failed',
);

const reconciliationWorker = new PollingWorker(
  60_000,
  async () => {
    const result = await reconciliationService.processDue(10);
    if (result.claimed > 0) logger.info(result, 'Processed scheduled reconciliation batch');
  },
  'Scheduled reconciliation worker failed',
);

const workers = [shopifyWebhookWorker, reconciliationWorker];

export function startWorkers(): void {
  for (const worker of workers) worker.start();
}

export async function stopWorkers(): Promise<void> {
  await Promise.all(workers.map((worker) => worker.stop()));
}
