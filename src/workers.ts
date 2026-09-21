import { logger } from './lib/logger.js';
import { PollingWorker } from './lib/polling-worker.js';
import { authEmailDeliveryService } from './modules/auth/auth.email-delivery.js';
import { billingReconciliationService } from './modules/billing/billing-reconciliation.service.js';
import { pixelAttributionService } from './modules/pixel/attribution/pixel-attribution.service.js';
import { pixelBehaviorService } from './modules/pixel/behavior/pixel-behavior.service.js';
import { pixelJourneyService } from './modules/pixel/journey/pixel-journey.service.js';
import { pixelService } from './modules/pixel/pixel.service.js';
import { pixelRollupStateRepair } from './modules/pixel/rollup/pixel-rollup-state-repair.js';
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

const authEmailWorker = new PollingWorker(
  10_000,
  async () => {
    const result = await authEmailDeliveryService.processDue(20);
    if (result.claimed > 0) logger.info(result, 'Processed auth email delivery batch');
  },
  'Auth email delivery worker failed',
);

const billingReconciliationWorker = new PollingWorker(
  60_000,
  async () => {
    const result = await billingReconciliationService.processDue(10);
    if (result.selected > 0) logger.info(result, 'Reconciled stale Shopify billing state');
  },
  'Shopify billing reconciliation worker failed',
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
    const repairedStates = await pixelRollupStateRepair.repairBehavior(10);
    if (result.storesRolled > 0 || result.failed > 0 || repairedStates > 0) {
      logger.info(
        { ...result, repairedStates },
        'Rolled up privacy-safe Stride Pixel behavioral facts',
      );
    }
  },
  'Stride Pixel behavioral rollup failed',
);

const pixelAttributionWorker = new PollingWorker(
  30_000,
  async () => {
    const result = await pixelAttributionService.rollupDirtyStores(10);
    const repairedStates = await pixelRollupStateRepair.repairAttribution(10);
    if (result.storesRolled > 0 || result.failed > 0 || repairedStates > 0) {
      logger.info(
        { ...result, repairedStates },
        'Rolled up privacy-safe Stride Pixel attribution evidence',
      );
    }
  },
  'Stride Pixel attribution rollup failed',
);

const pixelRetentionWorker = new PollingWorker(
  60_000,
  async () => {
    // Raw evidence expires first. Deleting expired source events rotates repair generations for
    // affected sessions. Drain one bounded repair batch immediately, then always run session
    // cleanup: the cleanup query itself excludes any session that still has repair work or stale
    // rollups, so one tenant's backlog cannot globally retain unrelated expired traces.
    const events = await pixelService.cleanupExpiredEvents();
    const repairs = await pixelJourneyService.repairDirtySessions(500);
    const sessions = await pixelJourneyService.cleanupExpiredSessions();

    if (sessions.deleted > 0 || events.deleted > 0 || repairs.selected > 0 || repairs.failed > 0) {
      logger.info({ sessions, events, repairs }, 'Deleted expired Stride Pixel behavioral traces');
    }
  },
  'Stride Pixel retention cleanup failed',
);

const workers = [
  shopifyWebhookWorker,
  tiktokWebhookWorker,
  authEmailWorker,
  billingReconciliationWorker,
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
