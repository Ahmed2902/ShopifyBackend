import { shopifyService } from '../shopify/shopify.module.js';
import { ReconciliationRepository } from './reconciliation.repository.js';
import { ReconciliationService } from './reconciliation.service.js';
import { ReconciliationWorker } from './reconciliation.worker.js';

export const reconciliationService = new ReconciliationService(
  new ReconciliationRepository(),
  shopifyService,
);

export const reconciliationWorker = new ReconciliationWorker(reconciliationService);
