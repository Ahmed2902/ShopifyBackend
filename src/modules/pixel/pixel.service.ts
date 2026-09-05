import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '../../generated/prisma/client.js';
import { env } from '../../config/env.js';
import { AppError } from '../../errors/app-error.js';
import { pixelJourneyService, type PixelJourneyService } from './journey/pixel-journey.service.js';
import {
  calculatePixelRetentionExpiresAt,
  extractStorefrontAttribution,
  isStorefrontBehaviorCaptureAllowed,
  sanitizeStorefrontUrl,
} from './pixel.privacy.js';
import { PixelRepository } from './pixel.repository.js';
import type {
  PixelDebugBatchInput,
  PixelIngestBatchInput,
  StorefrontEventInput,
} from './pixel.schema.js';
import { ShopifyPixelProvisioner } from './pixel.shopify.js';
import {
  PIXEL_CLEANUP_BATCH_SIZE,
  PIXEL_COLLECTOR_TOKEN_BYTES,
  type StorefrontAttributionInput,
} from './pixel.types.js';

const COLLECTOR_PATH = '/v1/pixel/events';
const TOKEN_PREFIX_LENGTH = 8;
const REQUIRED_SHOPIFY_SCOPES = ['write_pixels', 'read_pixels', 'read_customer_events'] as const;
type StoreScopedEventInput = Omit<Prisma.StorefrontEventCreateManyInput, 'storeId'>;

function hashCollectorToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function serializeTokenHash(token: string): string {
  return hashCollectorToken(token).toString('hex');
}

function tokenMatches(token: string, expectedHexHash: string | null | undefined): boolean {
  if (!expectedHexHash) return false;
  const actual = hashCollectorToken(token);
  const expected = Buffer.from(expectedHexHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message.slice(0, 1_000);
  return 'Pixel installation failed';
}

function mergeAttribution(event: StorefrontEventInput): StorefrontAttributionInput {
  return {
    ...extractStorefrontAttribution(event.pageUrl),
    ...extractStorefrontAttribution(event.landingPageUrl),
    ...(event.attribution ?? {}),
  };
}

export class PixelService {
  constructor(
    private readonly repository: PixelRepository = new PixelRepository(),
    private readonly shopifyProvisioner: ShopifyPixelProvisioner = new ShopifyPixelProvisioner(),
    private readonly now: () => Date = () => new Date(),
    private readonly journeyService: PixelJourneyService = pixelJourneyService,
  ) {}

  async installShopifyPixel(storeId: string) {
    const collectorUrl = this.getCollectorUrl();
    const existing = await this.repository.findInstallationByStoreId(storeId);
    const requestedInstallationId = existing?.id ?? randomUUID();
    const collectorToken = randomBytes(PIXEL_COLLECTOR_TOKEN_BYTES).toString('base64url');
    const collectorTokenHash = serializeTokenHash(collectorToken);
    const collectorTokenPrefix = collectorToken.slice(0, TOKEN_PREFIX_LENGTH);
    const hadWorkingInstallation = existing?.status === 'ACTIVE';

    // The pending hash doubles as an ownership token. A healthy in-flight install cannot be
    // overwritten by a second request; a previously failed operation (lastError != null) can be
    // reclaimed on the next explicit retry.
    const staged = await this.repository.stageInstallation({
      id: requestedInstallationId,
      storeId,
      collectorTokenHash,
      collectorTokenPrefix,
      status: hadWorkingInstallation ? 'ACTIVE' : 'PROVISIONING',
    });
    if (!staged) {
      throw new AppError(
        'A pixel installation is already in progress for this store',
        409,
        'PIXEL_INSTALLATION_IN_PROGRESS',
      );
    }
    const installationId = staged.id;

    let webPixel: { id: string };
    try {
      webPixel = await this.shopifyProvisioner.upsert({
        storeId,
        existingWebPixelId: existing?.shopifyWebPixelId ?? staged.shopifyWebPixelId ?? null,
        settings: {
          collectorUrl,
          installationId,
          collectorToken,
        },
      });
    } catch (error) {
      await this.repository
        .rollbackStagedInstallation(
          installationId,
          collectorTokenHash,
          hadWorkingInstallation,
          errorMessage(error),
        )
        .catch(() => undefined);
      throw error;
    }

    try {
      const installation = await this.repository.finalizeInstallation({
        id: installationId,
        expectedPendingTokenHash: collectorTokenHash,
        shopifyWebPixelId: webPixel.id,
        installedAt: this.now(),
      });
      if (!installation) {
        throw new AppError(
          'Pixel installation ownership changed before finalization',
          409,
          'PIXEL_INSTALLATION_SUPERSEDED',
        );
      }

      return {
        ...installation,
        collectorUrl,
        requiredShopifyScopes: REQUIRED_SHOPIFY_SCOPES,
      };
    } catch (error) {
      // Shopify already accepted these settings. Keep the staged token recoverable, but only if
      // this request still owns that staged hash; a stale request must never mutate a newer one.
      await this.repository
        .recordInstallationError(installationId, collectorTokenHash, errorMessage(error))
        .catch(() => undefined);
      throw error;
    }
  }

  async getStatus(storeId: string) {
    const installation = await this.repository.findInstallationByStoreId(storeId);
    if (!installation) {
      return {
        status: 'NOT_INSTALLED' as const,
        collectorUrl: this.getCollectorUrl(false),
        requiredShopifyScopes: REQUIRED_SHOPIFY_SCOPES,
      };
    }

    return {
      ...installation,
      collectorUrl: this.getCollectorUrl(false),
      requiredShopifyScopes: REQUIRED_SHOPIFY_SCOPES,
    };
  }

  async ingest(batch: PixelIngestBatchInput) {
    const installation = await this.repository.findInstallationForIngress(batch.installationId);
    const acceptedStatus = installation?.status === 'ACTIVE' || installation?.status === 'PROVISIONING';
    const credentialMatches = Boolean(
      installation &&
        (tokenMatches(batch.collectorToken, installation.collectorTokenHash) ||
          tokenMatches(batch.collectorToken, installation.pendingCollectorTokenHash)),
    );
    if (!installation || !acceptedStatus || !credentialMatches) {
      throw new AppError('Pixel collector credentials are invalid', 401, 'PIXEL_UNAUTHORIZED');
    }

    const receivedAt = this.now();
    const eligible = batch.events.filter((event) =>
      isStorefrontBehaviorCaptureAllowed(event.consentState),
    );
    const normalized = eligible.map((event) => this.normalizeEvent(event, receivedAt));
    // Raw events and their repair markers commit together. A process exit can no longer leave a
    // durable event with no way for the repair worker to discover its session.
    const inserted = await this.repository.insertEvents(installation.storeId, normalized, receivedAt);

    if (eligible.length > 0) {
      const latestEventAt = eligible.reduce((latest, event) => {
        const eventAt = new Date(event.eventAt);
        return eventAt > latest ? eventAt : latest;
      }, new Date(0));
      await this.repository.touchInstallation(installation.id, latestEventAt);
    }

    const sessionIds = [
      ...new Set(
        normalized
          .map((event) => event.sessionId)
          .filter((sessionId): sessionId is string => Boolean(sessionId)),
      ),
    ];
    if (sessionIds.length > 0) {
      await this.journeyService
        .materializeSessions(installation.storeId, sessionIds)
        .catch(() => undefined);
    }

    return {
      received: batch.events.length,
      persisted: inserted,
      duplicates: eligible.length - inserted,
      suppressedForConsent: batch.events.length - eligible.length,
    };
  }

  validateDebug(batch: PixelDebugBatchInput) {
    const receivedAt = this.now();
    const events = batch.events.map((event) => ({
      captureAllowed: isStorefrontBehaviorCaptureAllowed(event.consentState),
      normalized: this.normalizeEvent(event, receivedAt),
    }));

    return {
      valid: true as const,
      receivedAt,
      events,
    };
  }

  async cleanupExpiredEvents(limit = PIXEL_CLEANUP_BATCH_SIZE) {
    const boundedLimit = Math.min(Math.max(1, Math.trunc(limit)), 10_000);
    const ids = await this.repository.findExpiredEventIds(this.now(), boundedLimit);
    const deleted = await this.repository.deleteEventsByIds(ids);
    return { selected: ids.length, deleted };
  }

  private normalizeEvent(
    event: StorefrontEventInput,
    receivedAt: Date,
  ): StoreScopedEventInput {
    const attribution = mergeAttribution(event);

    return {
      eventId: event.eventId,
      eventVersion: event.eventVersion,
      eventName: event.eventName,
      eventAt: new Date(event.eventAt),
      receivedAt,
      anonymousVisitorId: event.anonymousVisitorId ?? null,
      sessionId: event.sessionId ?? null,
      consentState: event.consentState,
      pageUrl: sanitizeStorefrontUrl(event.pageUrl),
      referrerUrl: sanitizeStorefrontUrl(event.referrerUrl),
      landingPageUrl: sanitizeStorefrontUrl(event.landingPageUrl),
      productExternalId: event.productExternalId ?? null,
      variantExternalId: event.variantExternalId ?? null,
      collectionExternalId: event.collectionExternalId ?? null,
      quantity: event.quantity ?? null,
      shopifyCheckoutToken: event.shopifyCheckoutToken ?? null,
      shopifyOrderExternalId: event.shopifyOrderExternalId ?? null,
      utmSource: attribution.utmSource ?? null,
      utmMedium: attribution.utmMedium ?? null,
      utmCampaign: attribution.utmCampaign ?? null,
      utmContent: attribution.utmContent ?? null,
      utmTerm: attribution.utmTerm ?? null,
      metaClickId: attribution.metaClickId ?? null,
      googleClickId: attribution.googleClickId ?? null,
      tiktokClickId: attribution.tiktokClickId ?? null,
      metaCampaignExternalId: attribution.metaCampaignExternalId ?? null,
      metaAdSetExternalId: attribution.metaAdSetExternalId ?? null,
      metaAdExternalId: attribution.metaAdExternalId ?? null,
      retentionExpiresAt: calculatePixelRetentionExpiresAt(
        receivedAt,
        env.PIXEL_RAW_EVENT_RETENTION_DAYS,
      ),
    };
  }

  private getCollectorUrl(): string;
  private getCollectorUrl(required: true): string;
  private getCollectorUrl(required: false): string | null;
  private getCollectorUrl(required = true): string | null {
    if (env.PIXEL_COLLECTOR_URL) return env.PIXEL_COLLECTOR_URL;
    if (env.APP_URL) return new URL(COLLECTOR_PATH, env.APP_URL).toString();
    if (!required) return null;
    throw new AppError(
      'APP_URL or PIXEL_COLLECTOR_URL must be configured before installing Stride Pixel',
      500,
      'PIXEL_COLLECTOR_URL_MISSING',
    );
  }
}

export const pixelService = new PixelService();
