import { env } from '../../config/env.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { billingService, type BillingService } from './billing.service.js';

export class BillingReconciliationService {
  constructor(private readonly billing: BillingService = billingService) {}

  async processDue(limit = 10, now = new Date()) {
    if (!env.SHOPIFY_APP_PRICING_ENABLED) return { selected: 0, succeeded: 0, failed: 0 };

    const staleBefore = new Date(
      now.getTime() - env.SHOPIFY_BILLING_VERIFY_TTL_SECONDS * 1000,
    );
    const subscriptions = await prisma.storeSubscription.findMany({
      where: {
        provider: 'SHOPIFY',
        status: 'ACTIVE',
        OR: [{ lastVerifiedAt: null }, { lastVerifiedAt: { lte: staleBefore } }],
      },
      orderBy: [{ lastVerifiedAt: 'asc' }, { updatedAt: 'asc' }],
      take: limit,
      select: { storeId: true },
    });

    let succeeded = 0;
    let failed = 0;
    for (const subscription of subscriptions) {
      try {
        await this.billing.refreshFromShopify(subscription.storeId);
        succeeded += 1;
      } catch (error) {
        failed += 1;
        logger.warn(
          {
            storeId: subscription.storeId,
            error: error instanceof Error ? error.message : String(error),
          },
          'Scheduled Shopify billing verification failed',
        );
      }
    }

    return { selected: subscriptions.length, succeeded, failed };
  }
}

export const billingReconciliationService = new BillingReconciliationService();
