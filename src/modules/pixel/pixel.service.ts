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
type StoreScopedEventInput = Omit<Prisma.StorefrontEventCreateManyInput, 'storeId'>;

function hashCollectorToken(token: string): Buffer {
  return createHash('sha256').update(token).digest();
}

function serializeTokenHash(token: string): string {
  return hashCollectorToken(token).toString('hex');
}

function tokenMatches(token: string, expectedHexHash: string): boolean {
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
    const installationId = existing?.id ?? randomUUID();
    const collectorToken = randomBytes(PIXEL_COLLECTOR_TOKEN_BYTES).toString('base64url');
    const collectorTokenHash = serializeTokenHash(collectorToken);
    const collectorTokenPrefix = collectorToken.slice(0, TOKEN_PREFIX_LENGTH);

    try {
      const webPixel = await this.shopifyProvisioner.upsert({
        storeId,
        existingWebPixelId: existing?.shopifyWebPixelId ?? null,
        settings: {
          collectorUrl,
          installationId,
          collectorToken,
        },
      });

      const installedAt = this.now();
      const installation = await this.repository.upsertInstallation({
        id: installationId,
        storeId,
        collectorTokenHash,
        collectorTokenPrefix,
        shopifyWebPixelId: webPixel.id,
        status: 'ACTIVE',
        installedAt,
        lastError: null,
      });

      return {
        ...installation,
        collectorUrl,
        requiredShopifyScopes: ['write_pixels', 'read_customer_events'] as const,
      };
    } catch (error) {
      const message = errorMessage(error);
      if (existing) {
        await this.repository.recordInstallationError(existing.id, message).catch(() => undefined);
      } else {
        await this.repository
          .upsertInstallation({
            id: installationId,
            storeId,
            collectorTokenHash,
            collectorTokenPrefix,
            shopifyWebPixelId: null,
            status: 'ERROR',
            installedAt: null,
            lastError: message,
          })
          .catch(() => undefined);
      }
      throw error;
    }
  }

  async getStatus(storeId: string) {
    const installation = await this.repository.findInstallationByStoreId(storeId);
    if (!installation) {
      return {
        status: 'NOT_INSTALLED' as const,
        collectorUrl: this.getCollectorUrl(false),
        requiredShopifyScopes: ['write_pixels', 'read_customer_events'] as const,
      };
    }

    return {
      ...installation,
      collectorUrl: this.getCollectorUrl(false),
      requiredShopifyScopes: ['write_pixels', 'read_customer_events'] as const,
    };
  }

  async ingest(batch: PixelIngestBatchInput) {
    const installation = await this.repository.findInstallationForIngress(batch.installationId);
    if (
      !installation ||
      installation.status !== 'ACTIVE' ||
      !tokenMatches(batch.collectorToken, installation.collectorTokenHash)
    ) {
      throw new AppError('Pixel collector credentials are invalid', 401, 'PIXEL_UNAUTHORIZED');
    }

    const receivedAt = this.now();
    const eligible = batch.events.filter((event) =>
      isStorefrontBehaviorCaptureAllowed(event.consentState),
    );
    const normalized = eligible.map((event) => this.normalizeEvent(event, receivedAt));
    const inserted = await this.repository.insertEvents(installation.storeId, normalized);

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
      // Raw event durability is the collector contract. Session materialization is derived and
      // repaired by a worker, so a temporary read-model failure must not turn a valid collector
      // write into an endless browser retry loop.
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
