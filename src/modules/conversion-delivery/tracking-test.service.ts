import { randomUUID } from 'node:crypto';
import { AppError } from '../../errors/app-error.js';
import { prisma } from '../../lib/prisma.js';
import { billingService } from '../billing/billing.service.js';
import { ConversionDeliveryRepository } from './conversion-delivery.repository.js';
import type { ConversionDestinationConfig, DeliveryClaim } from './conversion-delivery.types.js';
import { sha256 } from './matching.js';
import { deliverMetaPurchase } from './providers/meta-conversion.provider.js';
import { deliverTikTokPurchase } from './providers/tiktok-conversion.provider.js';
import { deliverGooglePurchase } from './providers/google-conversion.provider.js';
import { ConversionProviderError } from './providers/conversion-provider.error.js';

const senders = { META: deliverMetaPurchase, TIKTOK: deliverTikTokPurchase, GOOGLE_ADS: deliverGooglePurchase };

export class TrackingTestService {
  constructor(
    private readonly repository = new ConversionDeliveryRepository(),
    private readonly billing = billingService,
    private readonly providers = senders,
  ) {}

  async run(storeId: string, destinationId: string, testEventCode?: string) {
    const destination = await this.repository.findDestinationWithSecret(storeId, destinationId);
    if (!destination || destination.status !== 'ACTIVE') {
      throw new AppError('Turn on sharing for this channel before running a test.', 409, 'TRACKING_TEST_DESTINATION_REQUIRED');
    }
    await this.billing.requireAdProviderReadOnly(storeId, destination.provider);
    if (destination.provider !== 'GOOGLE_ADS' && !testEventCode) {
      throw new AppError('Copy the test code from this channel’s Events Manager first.', 400, 'TRACKING_TEST_CODE_REQUIRED');
    }
    const store = await prisma.store.findUnique({ where: { id: storeId }, select: { myshopifyDomain: true, currencyCode: true } });
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    const now = new Date();
    const testId = `metrico-test:${randomUUID()}`;
    const config = (destination.configJson ?? {}) as ConversionDestinationConfig;
    // This synthetic diagnostic is never queued or recorded as a Shopify purchase.
    // Customer data is not loaded. The identifiers below exist only for testing.
    const delivery = {
      id: testId, storeId, provider: destination.provider, eventName: 'PURCHASE',
      eventKey: testId, shopifyOrderId: 'gid://shopify/Order/0', sourceOrderId: null,
      sourceEventId: null, eventAt: now, attributionEventAt: now, clickId: null,
      eventSourceUrl: `https://${store.myshopifyDomain}/`, value: '1.00', currencyCode: store.currencyCode,
      match: {
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36 MetricoTrackingTest/1.0',
        meta: { external_id: [sha256(testId)] },
        tiktok: { external_id: sha256(testId) },
        google: { userIdentifiers: [{ emailAddress: sha256(`${testId}@example.invalid`) }] },
      },
      destination: { ...destination, configJson: { ...config, testEventCode } },
    } as unknown as DeliveryClaim;
    const beforeSend = async () => {
      await this.billing.requireAdProviderReadOnly(storeId, destination.provider);
      const current = await this.repository.findDestinationWithSecret(storeId, destinationId);
      if (!current || current.status !== 'ACTIVE' || current.provider !== destination.provider ||
          current.externalId !== destination.externalId || current.accessTokenCiphertext !== destination.accessTokenCiphertext ||
          JSON.stringify(current.configJson) !== JSON.stringify(destination.configJson)) {
        throw new AppError('Sharing settings changed. Refresh this page and try again.', 409, 'TRACKING_TEST_SETTINGS_CHANGED');
      }
    };
    try {
      const receipt = destination.provider === 'GOOGLE_ADS'
        ? await this.providers.GOOGLE_ADS(delivery, beforeSend, { validateOnly: true })
        : await this.providers[destination.provider](delivery, beforeSend);
      return {
        provider: destination.provider, status: destination.provider === 'GOOGLE_ADS' ? 'VALIDATION_PASSED' : 'TEST_EVENT_ACCEPTED',
        testId, providerRequestId: receipt.providerRequestId, checkedAt: now.toISOString(),
        validationWarningCount: receipt.validationWarningCount ?? 0,
        liveDeliveryVerified: false,
      };
    } catch (error) {
      if (!(error instanceof ConversionProviderError)) throw error;
      throw new AppError('The channel did not accept the test. Check its sharing permission and destination, then try again.', 422,
        'TRACKING_TEST_FAILED', { provider: destination.provider, providerCode: error.providerCode ?? 'UNKNOWN', retryable: error.retryable });
    }
  }
}

export const trackingTestService = new TrackingTestService();
