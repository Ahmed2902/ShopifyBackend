import { AppError } from '../../errors/app-error.js';
import { logger } from '../../lib/logger.js';
import { prisma } from '../../lib/prisma.js';
import { billingService } from '../billing/billing.service.js';
import { decryptSecret, encryptSecret, toErrorMessage } from '../integrations/integration.utils.js';
import { normalizeMetaAdAccountId } from '../meta/meta.utils.js';
import { normalizeCustomerId } from '../google-ads/google-ads.utils.js';
import { ConversionDeliveryRepository } from './conversion-delivery.repository.js';
import type {
  ConversionLineItem,
  ConversionProviderAdapter,
  ConversionProviderCode,
  ConversionProviderDestination,
  ConversionProviderEvent,
} from './conversion-delivery.types.js';
import { ConversionProviderError } from './conversion-delivery.types.js';
import { MetaConversionProvider } from './providers/meta-conversion.provider.js';
import { TikTokConversionProvider } from './providers/tiktok-conversion.provider.js';
import { GoogleAdsConversionProvider } from './providers/google-ads-conversion.provider.js';

const DEFAULT_DESTINATION_BATCH = 50;
const DEFAULT_CANDIDATE_BATCH = 100;
const DEFAULT_DELIVERY_BATCH = 50;
const MAX_ATTEMPTS = 8;
const PROCESSING_LEASE_MS = 10 * 60_000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 6 * 60 * 60_000;

function bounded(value: number, max: number) {
  return Math.min(Math.max(1, Math.trunc(value)), max);
}

function retryDelayMs(attempts: number) {
  return Math.min(RETRY_BASE_MS * 2 ** Math.min(Math.max(attempts - 1, 0), 8), RETRY_MAX_MS);
}

function normalizedAccount(provider: ConversionProviderCode, value: string) {
  if (provider === 'META') return normalizeMetaAdAccountId(value);
  if (provider === 'GOOGLE_ADS') return normalizeCustomerId(value);
  const id = value.trim();
  if (!/^\d+$/.test(id)) {
    throw new AppError('Invalid TikTok advertiser ID', 400, 'INVALID_TIKTOK_ADVERTISER_ID');
  }
  return id;
}

function normalizeDestinationId(provider: ConversionProviderCode, value: string) {
  const id = value.trim();
  if (!id || id.length > 256) {
    throw new AppError('Conversion destination ID is invalid', 400, 'INVALID_CONVERSION_DESTINATION');
  }
  if (provider === 'META' && !/^\d+$/.test(id)) {
    throw new AppError('Meta Dataset/Pixel ID must be numeric', 400, 'INVALID_META_DATASET_ID');
  }
  if (provider === 'GOOGLE_ADS') {
    const actionId = id.split('/').filter(Boolean).at(-1) ?? '';
    if (!/^\d+$/.test(actionId)) {
      throw new AppError(
        'Google Ads conversion action ID must be numeric or a conversion-action resource name',
        400,
        'INVALID_GOOGLE_CONVERSION_ACTION_ID',
      );
    }
  }
  return id;
}

function publicDestination<T extends {
  secretCiphertext?: string | null;
}>(destination: T): Omit<T, 'secretCiphertext'> & { credentialConfigured: boolean } {
  const { secretCiphertext, ...safe } = destination;
  return { ...safe, credentialConfigured: Boolean(secretCiphertext) };
}

function lineItems(
  items: Array<{
    shopifyProductId: string | null;
    shopifyVariantId: string | null;
    sku: string | null;
    quantity: number;
    currentQuantity: number;
    discountedUnitPriceAfterAllDiscounts: { toString(): string } | null;
    originalUnitPrice: { toString(): string } | null;
  }>,
): ConversionLineItem[] {
  return items.flatMap((item) => {
    const contentId = item.shopifyVariantId ?? item.shopifyProductId ?? item.sku;
    if (!contentId) return [];
    return [
      {
        contentId,
        quantity: Math.max(item.currentQuantity || item.quantity, 1),
        price:
          item.discountedUnitPriceAfterAllDiscounts?.toString() ??
          item.originalUnitPrice?.toString() ??
          null,
      },
    ];
  });
}

export class ConversionDeliveryService {
  private readonly adapters: Map<ConversionProviderCode, ConversionProviderAdapter>;

  constructor(
    private readonly repository: ConversionDeliveryRepository = new ConversionDeliveryRepository(),
    adapters: ConversionProviderAdapter[] = [
      new MetaConversionProvider(),
      new TikTokConversionProvider(),
      new GoogleAdsConversionProvider(),
    ],
    private readonly now: () => Date = () => new Date(),
  ) {
    this.adapters = new Map(adapters.map((adapter) => [adapter.provider, adapter]));
  }

  async listDestinations(storeId: string) {
    const items = await this.repository.listDestinations(storeId);
    return { items: items.map((item) => publicDestination(item)) };
  }

  async configureDestination(
    storeId: string,
    input: {
      provider: ConversionProviderCode;
      accountExternalId: string;
      destinationExternalId: string;
      accessToken?: string;
      testEventCode?: string | null;
    },
  ) {
    await billingService.requireEntitlement(storeId, 'SERVER_SIDE_CONVERSIONS');
    const accountExternalId = normalizedAccount(input.provider, input.accountExternalId);
    const destinationExternalId = normalizeDestinationId(input.provider, input.destinationExternalId);
    await this.assertSelectedAccount(storeId, input.provider, accountExternalId);

    const existing = await this.repository.findDestinationIdentity({
      storeId,
      provider: input.provider,
      accountExternalId,
      destinationExternalId,
    });

    let secretCiphertext: string | null = null;
    if (input.provider === 'GOOGLE_ADS') {
      if (input.accessToken) {
        throw new AppError(
          'Google Ads server conversions reuse the connected Google Ads OAuth credential; do not submit a separate token.',
          400,
          'GOOGLE_CONVERSION_TOKEN_NOT_ACCEPTED',
        );
      }
    } else {
      const supplied = input.accessToken?.trim();
      if (supplied) secretCiphertext = encryptSecret(supplied);
      else secretCiphertext = existing?.secretCiphertext ?? null;
      if (!secretCiphertext) {
        throw new AppError(
          input.provider === 'META'
            ? 'A Meta Dataset/Pixel access token is required.'
            : 'A TikTok Events API access token is required.',
          400,
          'CONVERSION_DESTINATION_TOKEN_REQUIRED',
        );
      }
    }

    const destination = await this.repository.upsertDestination({
      storeId,
      provider: input.provider,
      accountExternalId,
      destinationExternalId,
      secretCiphertext,
      testEventCode: input.testEventCode?.trim() || null,
    });
    return publicDestination(destination);
  }

  async activateDestination(storeId: string, destinationId: string) {
    await billingService.requireEntitlement(storeId, 'SERVER_SIDE_CONVERSIONS');
    const destination = await this.repository.findDestination(storeId, destinationId);
    if (!destination) {
      throw new AppError('Conversion destination not found', 404, 'CONVERSION_DESTINATION_NOT_FOUND');
    }
    await this.assertSelectedAccount(storeId, destination.provider, destination.accountExternalId);
    if (destination.provider !== 'GOOGLE_ADS' && !destination.secretCiphertext) {
      throw new AppError(
        'Conversion destination credential is not configured',
        409,
        'CONVERSION_DESTINATION_TOKEN_REQUIRED',
      );
    }
    const activated = await this.repository.activateDestination(storeId, destinationId, this.now());
    if (!activated) {
      throw new AppError('Conversion destination not found', 404, 'CONVERSION_DESTINATION_NOT_FOUND');
    }
    return publicDestination(activated);
  }

  async pauseDestination(storeId: string, destinationId: string) {
    const result = await this.repository.pauseDestination(storeId, destinationId);
    if (result.count === 0) {
      throw new AppError('Conversion destination not found', 404, 'CONVERSION_DESTINATION_NOT_FOUND');
    }
    const destination = await this.repository.findDestination(storeId, destinationId);
    return destination ? publicDestination(destination) : null;
  }

  listDeliveries(
    storeId: string,
    input: {
      destinationId?: string;
      status?: 'PENDING' | 'PROCESSING' | 'RETRYING' | 'SENT' | 'DEAD';
      page: number;
      limit: number;
    },
  ) {
    return this.repository.listDeliveries(storeId, input);
  }

  async retryDelivery(storeId: string, deliveryId: string) {
    await billingService.requireEntitlement(storeId, 'SERVER_SIDE_CONVERSIONS');
    const result = await this.repository.retryDelivery(storeId, deliveryId, this.now());
    if (result.count === 0) {
      throw new AppError(
        'Only failed or retrying conversion deliveries can be manually retried.',
        409,
        'CONVERSION_DELIVERY_NOT_RETRYABLE',
      );
    }
    return { retried: true };
  }

  async enqueueEligiblePurchases(
    destinationLimit = DEFAULT_DESTINATION_BATCH,
    candidateLimit = DEFAULT_CANDIDATE_BATCH,
  ) {
    const destinations = await this.repository.activeDestinations(bounded(destinationLimit, 200));
    let candidates = 0;
    let created = 0;
    let pausedForEntitlement = 0;

    for (const destination of destinations) {
      try {
        await billingService.requireEntitlement(destination.storeId, 'SERVER_SIDE_CONVERSIONS');
      } catch {
        await this.repository.pauseDestination(destination.storeId, destination.id);
        pausedForEntitlement += 1;
        continue;
      }

      const rows = await this.repository.findEligibleCandidates(
        destination,
        bounded(candidateLimit, 500),
      );
      candidates += rows.length;
      const result = await this.repository.createDeliveries(
        rows.map((candidate) => ({
          storeId: destination.storeId,
          destinationId: destination.id,
          sourceOrderId: candidate.orderId,
          eventKey: ConversionDeliveryRepository.eventKey(candidate.shopifyOrderId),
          providerEventId: ConversionDeliveryRepository.providerEventId(candidate.shopifyOrderId),
          eventAt: candidate.eventAt,
          sourceEventAt: candidate.sourceEventAt,
          value: candidate.value,
          currencyCode: candidate.currencyCode.toUpperCase(),
          sourceUrl: candidate.sourceUrl,
          matchKeyKind: candidate.matchKeyKind,
          matchKeyCiphertext: encryptSecret(candidate.matchKey),
          consentState: candidate.consentState,
          nextAttemptAt: this.now(),
        })),
      );
      created += result.count;
    }

    return { destinations: destinations.length, candidates, created, pausedForEntitlement };
  }

  async processDue(limit = DEFAULT_DELIVERY_BATCH) {
    const now = this.now();
    const claimed = await this.repository.claimDue(
      now,
      new Date(now.getTime() - PROCESSING_LEASE_MS),
      bounded(limit, 200),
    );
    let sent = 0;
    let retrying = 0;
    let dead = 0;
    let paused = 0;

    for (const delivery of claimed) {
      try {
        await billingService.requireEntitlement(delivery.storeId, 'SERVER_SIDE_CONVERSIONS');
      } catch {
        await this.repository.pauseDestination(delivery.storeId, delivery.destinationId);
        await this.repository.markRetry(
          delivery.id,
          'SERVER_SIDE_CONVERSIONS_NOT_ENTITLED',
          'Server-side conversion delivery is paused because the current subscription is not entitled.',
          new Date(now.getTime() + 24 * 60 * 60_000),
        );
        paused += 1;
        continue;
      }

      const adapter = this.adapters.get(delivery.destination.provider);
      if (!adapter) {
        await this.repository.markDead(
          delivery.id,
          'CONVERSION_PROVIDER_UNSUPPORTED',
          `No server-side conversion adapter is registered for ${delivery.destination.provider}.`,
          null,
        );
        dead += 1;
        continue;
      }

      let secret: string | null = null;
      let matchKey: string;
      try {
        secret = delivery.destination.secretCiphertext
          ? decryptSecret(delivery.destination.secretCiphertext)
          : null;
        matchKey = decryptSecret(delivery.matchKeyCiphertext);
      } catch {
        await this.repository.markDead(
          delivery.id,
          'CONVERSION_CREDENTIAL_DECRYPTION_FAILED',
          'Stored conversion credential could not be decrypted.',
          null,
        );
        await this.repository.markDestinationError(
          delivery.destinationId,
          'CONVERSION_CREDENTIAL_DECRYPTION_FAILED',
          'Stored conversion credential could not be decrypted.',
        );
        dead += 1;
        continue;
      }

      const destination: ConversionProviderDestination = {
        provider: delivery.destination.provider,
        accountExternalId: delivery.destination.accountExternalId,
        destinationExternalId: delivery.destination.destinationExternalId,
        secret,
        testEventCode: delivery.destination.testEventCode,
      };
      const event: ConversionProviderEvent = {
        eventId: delivery.providerEventId,
        orderId: delivery.providerEventId,
        eventAt: delivery.eventAt,
        sourceEventAt: delivery.sourceEventAt,
        sourceUrl: delivery.sourceUrl,
        value: delivery.value.toString(),
        currencyCode: delivery.currencyCode,
        matchKeyKind: delivery.matchKeyKind,
        matchKey,
        consentState: delivery.consentState as 'GRANTED' | 'NOT_REQUIRED',
        contents: lineItems(delivery.sourceOrder.lineItems),
      };

      try {
        const result = await adapter.send({
          storeId: delivery.storeId,
          destination,
          event,
        });
        await this.repository.markSent(delivery.id, delivery.destinationId, result.requestId, this.now());
        sent += 1;
      } catch (error) {
        const message = toErrorMessage(error);
        if (error instanceof ConversionProviderError) {
          if (error.destinationInvalid) {
            await this.repository.markDestinationError(delivery.destinationId, error.code, message);
          }
          if (error.retryable && delivery.attempts < MAX_ATTEMPTS && !error.destinationInvalid) {
            await this.repository.markRetry(
              delivery.id,
              error.code,
              message,
              new Date(this.now().getTime() + retryDelayMs(delivery.attempts)),
            );
            retrying += 1;
          } else {
            await this.repository.markDead(delivery.id, error.code, message, error.requestId);
            dead += 1;
          }
          continue;
        }

        if (delivery.attempts < MAX_ATTEMPTS) {
          await this.repository.markRetry(
            delivery.id,
            'CONVERSION_DELIVERY_FAILED',
            message,
            new Date(this.now().getTime() + retryDelayMs(delivery.attempts)),
          );
          retrying += 1;
        } else {
          await this.repository.markDead(
            delivery.id,
            'CONVERSION_DELIVERY_FAILED',
            message,
            null,
          );
          dead += 1;
        }
        logger.warn(
          {
            deliveryId: delivery.id,
            destinationId: delivery.destinationId,
            provider: delivery.destination.provider,
          },
          'Server-side conversion delivery failed',
        );
      }
    }

    return { claimed: claimed.length, sent, retrying, dead, paused };
  }

  private async assertSelectedAccount(
    storeId: string,
    provider: ConversionProviderCode,
    accountExternalId: string,
  ) {
    if (provider === 'META') {
      const connection = await prisma.metaConnection.findUnique({
        where: { storeId },
        select: { status: true, selectedAdAccountIds: true },
      });
      const selected = (connection?.selectedAdAccountIds ?? []).map(normalizeMetaAdAccountId);
      if (!connection || connection.status !== 'ACTIVE' || !selected.includes(accountExternalId)) {
        throw new AppError(
          'Meta conversion destination must belong to a currently selected Meta ad account.',
          409,
          'META_CONVERSION_ACCOUNT_NOT_SELECTED',
        );
      }
      return;
    }

    if (provider === 'TIKTOK') {
      const connection = await prisma.tikTokConnection.findUnique({
        where: { storeId },
        select: { status: true, selectedAdvertiserIds: true },
      });
      if (
        !connection ||
        connection.status !== 'ACTIVE' ||
        !connection.selectedAdvertiserIds.includes(accountExternalId)
      ) {
        throw new AppError(
          'TikTok conversion destination must belong to a currently selected TikTok advertiser.',
          409,
          'TIKTOK_CONVERSION_ACCOUNT_NOT_SELECTED',
        );
      }
      return;
    }

    const connection = await prisma.googleAdsConnection.findUnique({
      where: { storeId },
      select: { status: true, selectedCustomerIds: true },
    });
    const selected = (connection?.selectedCustomerIds ?? []).map(normalizeCustomerId);
    if (!connection || connection.status !== 'ACTIVE' || !selected.includes(accountExternalId)) {
      throw new AppError(
        'Google conversion destination must belong to a currently selected Google Ads customer.',
        409,
        'GOOGLE_CONVERSION_ACCOUNT_NOT_SELECTED',
      );
    }
  }
}

export const conversionDeliveryService = new ConversionDeliveryService();
