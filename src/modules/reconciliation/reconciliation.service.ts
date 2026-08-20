import type { ShopifyService } from '../shopify/shopify.service.js';
import type { ReconciliationRepository } from './reconciliation.repository.js';

const CLAIM_STALE_MS = 30 * 60_000;
const FAILURE_RETRY_MS = 15 * 60_000;

export class ReconciliationService {
  constructor(
    private readonly repository: ReconciliationRepository,
    private readonly shopifyService: ShopifyService,
  ) {}

  async processDue(limit = 10): Promise<{ claimed: number; succeeded: number; failed: number }> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - CLAIM_STALE_MS);
    const ids = await this.repository.listDueShopifyConnectionIds(limit, now, staleBefore);
    let claimed = 0;
    let succeeded = 0;
    let failed = 0;

    for (const connectionId of ids) {
      const claim = await this.repository.tryClaimShopify(connectionId, now, staleBefore);
      if (!claim.claimed) continue;
      claimed += 1;

      try {
        await this.shopifyService.reconcileStoreData(claim.storeId);
        succeeded += 1;
      } catch {
        failed += 1;
        await this.repository.markShopifyFailed(
          connectionId,
          new Date(Date.now() + FAILURE_RETRY_MS),
        );
      }
    }

    return { claimed, succeeded, failed };
  }
}
