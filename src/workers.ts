import { logger } from './lib/logger.js';
import { PollingWorker } from './lib/polling-worker.js';
import { pixelAttributionService } from './modules/pixel/attribution/pixel-attribution.service.js';
import { pixelBehaviorService } from './modules/pixel/behavior/pixel-behavior.service.js';
import { pixelJourneyService } from './modules/pixel/journey/pixel-journey.service.js';
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

const pixelJourneyWorker = new PollingWorker(
  30_000,
  async () => {
    const [sessions, orders] = await Promise.all([
      pixelJourneyService.repairDirtySessions(100),
      pixelJourneyService.linkPendingOrders(100),
    ]);
    if (sessions.materialized > 0 || sessions.failed > 0 || orders.linked > 0) {
      logger.info({ sessions, orders }, 'Reconciled Stride Pixel journey read model');
    }
  },
  'Stride Pixel journey reconciliation failed',
);

const pixelBehaviorWorker = new PollingWorker(
  30_000,
  async () => {
    const result = await pixelBehaviorService.rollupDirtyStores(10);
    if (result.storesRolled > 0 || result.failed > 0) {
      logger.info(result, 'Rolled up privacy-safe Stride Pixel behavioral facts');
    }
  },
  'Stride Pixel behavioral rollup failed',
);

const pixelAttributionWorker = new PollingWorker(
  30_000,
  async () => {
    const result = await pixelAttributionService.rollupDirtyStores(10);
    if (result.storesRolled > 0 || result.failed > 0) {
      logger.info(result, 'Rolled up privacy-safe Stride Pixel attribution evidence');
    }
  },
  'Stride Pixel attribution rollup failed',
);

const pixelRetentionWorker = new PollingWorker(
  60_000,
  async () => {
    // Raw evidence expires first. Deleting an expired event rotates a repair generation whenever
    // newer source evidence survives in that browser session. Drain one bounded repair batch
    // immediately and defer session deletion whenever any repair work was observed; this keeps an
    // old trace from being deleted before its surviving evidence has been rematerialized and its
    // old/new cohort dates can be rolled up.
    const events = await pixelService.cleanupExpiredEvents();
    const repairs = await pixelJourneyService.repairDirtySessions(500);
    const sessions =
      repairs.selected === 0
        ? await pixelJourneyService.cleanupExpiredSessions()
        : { selected: 0, deleted: 0, deferredForRepairBacklog: true };

    if (sessions.deleted > 0 || events.deleted > 0 || repairs.selected > 0 || repairs.failed > 0) {
      logger.info({ sessions, events, repairs }, 'Deleted expired Stride Pixel behavioral traces');
    }
  },
  'Stride Pixel retention cleanup failed',
);

const workers = [
  shopifyWebhookWorker,
  tiktokWebhookWorker,
  reconciliationWorker,
  pixelJourneyWorker,
  pixelBehaviorWorker,
  pixelAttributionWorker,
  pixelRetentionWorker,
];

export function startWorkers(): void {
  for (const worker of workers) worker.start();
}

export async function stopWorkers(): Promise<void> {
  await Promise.all(workers.map((worker) => worker.stop()));
}