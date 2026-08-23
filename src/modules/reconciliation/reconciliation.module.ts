import { logger } from '../../lib/logger.js';
import { PollingWorker } from '../../lib/polling-worker.js';
import { shopifyService } from '../shopify/shopify.module.js';
import { ReconciliationRepository } from './reconciliation.repository.js';
import { ReconciliationService } from './reconciliation.service.js';

export const reconciliationService = new ReconciliationService(
  new ReconciliationRepository(),
  shopifyService,
);

export const reconciliationWorker = new PollingWorker(
  60_000,
  async () => {
    const result = await reconciliationService.processDue(10);
    if (result.claimed > 0) logger.info(result, 'Processed scheduled reconciliation batch');
  },
  'Scheduled reconciliation worker failed',
);
