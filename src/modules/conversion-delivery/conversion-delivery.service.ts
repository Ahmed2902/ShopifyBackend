import type { AdvertisingProvider, ConversionDeliveryStatus } from '../../generated/prisma/client.js';
import { AppError } from '../../errors/app-error.js';
import { encryptSecret } from '../integrations/integration.utils.js';
import { ConversionDeliveryRepository } from './conversion-delivery.repository.js';
import type { ConfigureDestinationInput, DeliveryClaim, PurchaseCandidate } from './conversion-delivery.types.js';
import { deliverGooglePurchase } from './providers/google-conversion.provider.js';
import { deliverMetaPurchase } from './providers/meta-conversion.provider.js';
import { ConversionProviderError, providerErrorMessage } from './providers/conversion-provider.error.js';
import { deliverTikTokPurchase } from './providers/tiktok-conversion.provider.js';

const MAX_ENQUEUE_BATCH = 1_000;
const MAX_DELIVERY_BATCH = 100;
const MAX_ATTEMPTS = 8;
const CLAIM_STALE_MS = 10 * 60_000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 6 * 60 * 60_000;

function retryDelayMs(attempt: number) {
  return Math.min(RETRY_BASE_MS * 2 ** Math.min(Math.max(attempt - 1, 0), 8), RETRY_MAX_MS);
}

function attributionFor(candidate: PurchaseCandidate, provider: AdvertisingProvider) {
  if (provider === 'META') {
    return { clickId: candidate.metaClickId, eventAt: candidate.metaClickEventAt };
  }
  if (provider === 'TIKTOK') {
    return { clickId: candidate.tiktokClickId, eventAt: candidate.tiktokClickEventAt };
  }
  return { clickId: candidate.googleClickId, eventAt: candidate.googleClickEventAt };
}

function publicProviderName(provider: AdvertisingProvider) {
  if (provider === 'META') return 'Meta';
  if (provider === 'TIKTOK') return 'TikTok';
  return 'Google Ads';
}

export class ConversionDeliveryService {
  constructor(
    private readonly repository: ConversionDeliveryRepository = new ConversionDeliveryRepository(),
    private readonly now: () => Date = () => new Date(),
  ) {}

  listDestinations(storeId: string) {
    return this.repository.listDestinations(storeId);
  }

  async configureDestination(storeId: string, input: ConfigureDestinationInput) {
    if (input.provider !== 'GOOGLE_ADS' && !input.accessToken) {
      throw new AppError(
        `${publicProviderName(input.provider)} server-side conversion setup requires an Events Manager access token`,
        400,
        'CONVERSION_DESTINATION_TOKEN_REQUIRED',
      );
    }
    if (input.provider === 'GOOGLE_ADS' && !input.config.customerId) {
      throw new AppError(
        'Google server-side conversion setup requires a Google Ads customer ID',
        400,
        'GOOGLE_CONVERSION_CUSTOMER_REQUIRED',
      );
    }

    const encrypted = input.accessToken ? encryptSecret(input.accessToken) : undefined;
    return this.repository.upsertDestination(storeId, input, encrypted);
  }

  async disableDestination(storeId: string, destinationId: string) {
    const destination = await this.repository.getDestination(storeId, destinationId);
    if (!destination) {
      throw new AppError(
        'Conversion destination not found',
        404,
        'CONVERSION_DESTINATION_NOT_FOUND',
      );
    }
    await this.repository.disableDestination(storeId, destinationId);
    return { ...destination, status: 'DISABLED' as const };
  }

  listDeliveries(
    storeId: string,
    input: { provider?: AdvertisingProvider; status?: ConversionDeliveryStatus; limit?: number },
  ) {
    const limit = Math.min(Math.max(1, Math.trunc(input.limit ?? 50)), 200);
    return this.repository.listDeliveries(storeId, { ...input, limit });
  }

  async enqueuePurchases(limit = 500) {
    const bounded = Math.min(Math.max(1, Math.trunc(limit)), MAX_ENQUEUE_BATCH);
    const [destinations, candidates] = await Promise.all([
      this.repository.activeDestinations(),
      this.repository.findPurchaseCandidates(bounded),
    ]);

    const destinationsByStore = new Map<string, typeof destinations>();
    for (const destination of destinations) {
      const items = destinationsByStore.get(destination.storeId) ?? [];
      items.push(destination);
      destinationsByStore.set(destination.storeId, items);
    }

    let eligible = 0;
    let enqueued = 0;
    for (const candidate of candidates) {
      for (const destination of destinationsByStore.get(candidate.storeId) ?? []) {
        const attribution = attributionFor(candidate, destination.provider);
        if (!attribution.clickId) continue;
        eligible += 1;
        const result = await this.repository.enqueue({
          storeId: candidate.storeId,
          destinationId: destination.id,
          provider: destination.provider,
          eventKey: `stride:purchase:${candidate.shopifyOrderId}`,
          sourceOrderId: candidate.orderId,
          shopifyOrderId: candidate.shopifyOrderId,
          eventAt: candidate.eventAt,
          value: candidate.value,
          currencyCode: candidate.currencyCode,
          clickId: attribution.clickId,
          attributionEventAt: attribution.eventAt,
          eventSourceUrl: candidate.eventSourceUrl,
        });
        if (result.created) enqueued += 1;
      }
    }

    return { candidates: candidates.length, destinations: destinations.length, eligible, enqueued };
  }

  async processDue(limit = 25) {
    const bounded = Math.min(Math.max(1, Math.trunc(limit)), MAX_DELIVERY_BATCH);
    const now = this.now();
    await this.repository.recoverStaleClaims(new Date(now.getTime() - CLAIM_STALE_MS));
    const claims = await this.repository.claimDue(bounded, now);
    let delivered = 0;
    let retrying = 0;
    let dead = 0;

    for (const claim of claims) {
      try {
        const result = await this.deliver(claim);
        await this.repository.markDelivered(claim.id, result.providerRequestId, this.now());
        delivered += 1;
      } catch (error) {
        const attempt = claim.attempts + 1;
        const explicitlyPermanent = error instanceof ConversionProviderError && !error.retryable;
        const isDead = explicitlyPermanent || attempt >= MAX_ATTEMPTS;
        const nextAttemptAt = isDead
          ? this.now()
          : new Date(this.now().getTime() + retryDelayMs(attempt));
        const code =
          error instanceof ConversionProviderError && error.providerCode
            ? ` [${error.providerCode}]`
            : '';
        await this.repository.markFailed(
          claim.id,
          isDead ? 'DEAD' : 'RETRY',
          nextAttemptAt,
          `${providerErrorMessage(error)}${code}`,
        );
        if (isDead) dead += 1;
        else retrying += 1;
      }
    }

    return { claimed: claims.length, delivered, retrying, dead };
  }

  private deliver(claim: DeliveryClaim) {
    if (claim.provider === 'META') return deliverMetaPurchase(claim);
    if (claim.provider === 'TIKTOK') return deliverTikTokPurchase(claim);
    return deliverGooglePurchase(claim);
  }
}

export const conversionDeliveryService = new ConversionDeliveryService();
