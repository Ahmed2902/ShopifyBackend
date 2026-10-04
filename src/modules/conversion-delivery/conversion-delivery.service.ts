import { storefrontEventKey } from './funnel.repository.js';
import { prepareConversionContents } from './conversion-content.js';
import { prisma } from '../../lib/prisma.js';
import { env } from '../../config/env.js';
import { enrichConversionSignal } from './signal-enrichment.service.js';
import { signalCoverage, type MatchEvidence } from './matching.js';
import type { ConversionDestinationConfig } from './conversion-delivery.types.js';
import type {
  AdvertisingProvider,
  ConversionDeliveryStatus,
} from '../../generated/prisma/client.js';
import { AppError } from '../../errors/app-error.js';
import {
  billingService,
  type BillingService,
  type V1AdProvider,
} from '../billing/billing.service.js';
import { encryptSecret } from '../integrations/integration.utils.js';
import { ConversionDeliveryRepository } from './conversion-delivery.repository.js';
import type {
  ConfigureDestinationInput,
  DeliveryClaim,
  PurchaseCandidate,
} from './conversion-delivery.types.js';
import { deliverGooglePurchase } from './providers/google-conversion.provider.js';
import { deliverMetaPurchase } from './providers/meta-conversion.provider.js';
import {
  ConversionConsentWithdrawnError,
  ConversionEntitlementChangedError,
  ConversionProviderError,
  providerErrorMessage,
} from './providers/conversion-provider.error.js';
import { deliverTikTokPurchase } from './providers/tiktok-conversion.provider.js';

const MAX_ENQUEUE_BATCH = 1_000;
const MAX_DELIVERY_BATCH = 100;
const MAX_ATTEMPTS = 8;
const CLAIM_STALE_MS = 10 * 60_000;
const RETRY_BASE_MS = 60_000;
const RETRY_MAX_MS = 6 * 60 * 60_000;
const BILLING_RETRY_MS = 6 * 60 * 60_000;

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

function billingProvider(provider: AdvertisingProvider): V1AdProvider {
  return provider;
}

export class ConversionDeliveryService {
  constructor(
    private readonly repository: ConversionDeliveryRepository = new ConversionDeliveryRepository(),
    private readonly now: () => Date = () => new Date(),
    private readonly billing: BillingService = billingService,
  ) {}

  listDestinations(storeId: string) {
    return this.repository.listDestinations(storeId);
  }

  async configureDestination(storeId: string, input: ConfigureDestinationInput) {
    await this.billing.requireAdProvider(storeId, billingProvider(input.provider));

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

    const billingAllowed = new Map<string, boolean>();
    const isAllowed = async (storeId: string, provider: AdvertisingProvider) => {
      const key = `${storeId}:${provider}`;
      if (billingAllowed.has(key)) return billingAllowed.get(key)!;
      try {
        await this.billing.requireAdProviderReadOnly(storeId, billingProvider(provider));
        billingAllowed.set(key, true);
        return true;
      } catch {
        billingAllowed.set(key, false);
        return false;
      }
    };

    let eligible = 0;
    let enqueued = 0;
    for (const candidate of candidates) {
      for (const destination of destinationsByStore.get(candidate.storeId) ?? []) {
        if (!(await isAllowed(candidate.storeId, destination.provider))) continue;
        const attribution = attributionFor(candidate, destination.provider);
        const config = (destination.configJson ?? {}) as ConversionDestinationConfig;
        if (
          !attribution.clickId &&
          !candidate.browserMatchAvailable &&
          !(config.enhancedMatching && env.SHOPIFY_ENHANCED_MATCHING_APPROVED)
        )
          continue;
        eligible += 1;
        const result = await this.repository.enqueue({
          storeId: candidate.storeId,
          destinationId: destination.id,
          provider: destination.provider,
          eventKey: storefrontEventKey(candidate.storeId, `purchase:${candidate.shopifyOrderId}`),
          sourceOrderId: candidate.orderId,
          sourceEventId: candidate.sourceEventId,
          sourceGenerationAt: candidate.sourceGenerationAt,
          shopifyOrderId: candidate.shopifyOrderId,
          eventAt: candidate.eventAt,
          value: candidate.value,
          currencyCode: candidate.currencyCode,
          clickId: attribution.clickId,
          clickIdKind:
            destination.provider === 'GOOGLE_ADS' ? (candidate.googleClickIdKind ?? 'gclid') : null,
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
    const claims: DeliveryClaim[] = await this.repository.claimDue(bounded, now);
    await prepareConversionContents(claims.filter((c) => Boolean(c.sourceEventId)));
    const enrichmentCache = new Map<
      string,
      Promise<{ match: MatchEvidence; customerIdentityKey?: string; matchingReasonCode?: string }>
    >();
    const billingAllowed = new Map<string, boolean>();
    let delivered = 0;
    let retrying = 0;
    let dead = 0;

    for (const claim of claims) {
      const key = `${claim.storeId}:${claim.provider}`;
      let allowed = billingAllowed.get(key);
      if (allowed === undefined) {
        try {
          await this.billing.requireAdProviderReadOnly(
            claim.storeId,
            billingProvider(claim.provider),
          );
          allowed = true;
        } catch {
          allowed = false;
        }
        billingAllowed.set(key, allowed);
      }

      if (!allowed) {
        // Billing/plan changes are reversible. Keep the delivery retryable without applying the
        // provider-attempt death threshold; an upgrade or Essentials channel selection can make it
        // eligible again later.
        await this.repository.pauseForBilling(
          claim.id,
          new Date(this.now().getTime() + BILLING_RETRY_MS),
        );
        retrying += 1;
        continue;
      }

      try {
        // Avoid preparing credentials when retained permission is already absent.
        if (
          !(await this.repository.hasAdvertisingConsent({
            ...claim,
            reportConnectionFailure: true,
          }))
        ) {
          await this.repository.discardForConsent(claim.id);
          dead += 1;
          continue;
        }
        if (claim.eventAt.getTime() < this.now().getTime() - 7 * 86400_000) {
          throw new ConversionProviderError(
            'The event exceeded Stride delivery retention',
            false,
            'EVENT_EXPIRED',
          );
        }
        if (claim.sourceEventId) {
          const config = (claim.destination.configJson ?? {}) as ConversionDestinationConfig;
          const cacheKey = JSON.stringify([
            claim.storeId,
            claim.sourceOrderId,
            claim.sourceEventId,
            claim.sourceGenerationAt,
            config.enhancedMatching === true,
          ]);
          let pending = enrichmentCache.get(cacheKey);
          if (!pending) {
            pending = (async () => {
              const match = await enrichConversionSignal(claim, async () => {
                try {
                  await this.billing.requireAdProviderReadOnly(
                    claim.storeId,
                    billingProvider(claim.provider),
                  );
                } catch {
                  throw new ConversionEntitlementChangedError();
                }
                if (
                  !(await this.repository.hasAdvertisingConsent({
                    ...claim,
                    matchingIntent: true,
                    reportConnectionFailure: true,
                  }))
                )
                  throw new ConversionConsentWithdrawnError();
              });
              return {
                match,
                customerIdentityKey: claim.customerIdentityKey,
                matchingReasonCode: claim.matchingReasonCode,
              };
            })();
            enrichmentCache.set(cacheKey, pending);
          }
          const enriched = await pending;
          claim.match = enriched.match;
          claim.customerIdentityKey = enriched.customerIdentityKey;
          claim.matchingReasonCode = enriched.matchingReasonCode;
          await this.repository.recordCoverage(
            claim.id,
            signalCoverage(claim.match, claim.provider, claim.clickId),
            claim.matchingReasonCode ?? null,
          );
        }
        if (claim.contentFacts)
          await prisma.conversionDelivery.updateMany({
            where: { id: claim.id, storeId: claim.storeId },
            data: { contentCoverage: claim.contentFacts },
          });
        const result = await this.deliver(claim);
        if (claim.matchingReasonCode)
          await this.repository.markDelivered(
            claim.id,
            result.providerRequestId,
            this.now(),
            claim.matchingReasonCode,
          );
        else await this.repository.markDelivered(claim.id, result.providerRequestId, this.now());
        if (claim.customerIdentityKey && claim.sourceOrderId && claim.sourceGenerationAt)
          await this.repository.linkCustomerIdentity(claim);
        delivered += 1;
      } catch (error) {
        if (
          error instanceof AppError &&
          /BILLING|SUBSCRIPTION|ENTITLEMENT|AD_PROVIDER/.test(error.code ?? '')
        ) {
          await this.repository.pauseForBilling(
            claim.id,
            new Date(this.now().getTime() + BILLING_RETRY_MS),
          );
          retrying += 1;
          continue;
        }
        if (error instanceof ConversionEntitlementChangedError) {
          await this.repository.pauseForBilling(
            claim.id,
            new Date(this.now().getTime() + BILLING_RETRY_MS),
          );
          retrying += 1;
          continue;
        }
        if (error instanceof ConversionConsentWithdrawnError) {
          await this.repository.discardForConsent(claim.id);
          dead += 1;
          continue;
        }
        if (
          error instanceof ConversionProviderError &&
          [
            'CONVERSION_CONNECTION_REAUTH_REQUIRED',
            'META_CAPI_CONNECTION_INACTIVE',
            'META_CAPI_PERMISSION_REQUIRED',
            'META_CAPI_REAUTH_REQUIRED',
            'GOOGLE_DATA_MANAGER_SCOPE_REQUIRED',
            'GOOGLE_ADS_REAUTH_REQUIRED',
            '190',
            '200',
            '401',
            '403',
            '40100',
            '40101',
            '40105',
            'UNAUTHENTICATED',
            'PERMISSION_DENIED',
          ].includes(error.providerCode ?? '')
        ) {
          await this.repository.pauseForConnection(
            claim.id,
            new Date(this.now().getTime() + BILLING_RETRY_MS),
          );
          retrying += 1;
          continue;
        }
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
    const beforeSend = async () => {
      try {
        await this.billing.requireAdProviderReadOnly(
          claim.storeId,
          billingProvider(claim.provider),
        );
      } catch {
        throw new ConversionEntitlementChangedError();
      }
      if (
        !(await this.repository.hasAdvertisingConsent({ ...claim, reportConnectionFailure: true }))
      ) {
        throw new ConversionConsentWithdrawnError();
      }
    };
    if (claim.provider === 'META') return deliverMetaPurchase(claim, beforeSend);
    if (claim.provider === 'TIKTOK') return deliverTikTokPurchase(claim, beforeSend);
    return deliverGooglePurchase(claim, beforeSend);
  }
}

export const conversionDeliveryService = new ConversionDeliveryService();
