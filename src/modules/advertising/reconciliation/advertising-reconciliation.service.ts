import { createHash, randomUUID } from 'node:crypto';
import type {
  AdvertisingProvider,
  AdvertisingReconciliationState,
} from '../../../generated/prisma/client.js';
import { AppError } from '../../../errors/app-error.js';
import { invalidateStoreDecisionCaches } from '../../../lib/store-decision-cache.js';
import { billingService, type BillingService } from '../../billing/billing.service.js';
import { googleAdsMappingService } from '../../google-ads/google-ads-mapping.service.js';
import type { GoogleAdsMappingService } from '../../google-ads/google-ads-mapping.service.js';
import { GoogleAdsRepository } from '../../google-ads/google-ads.repository.js';
import { GoogleAdsService } from '../../google-ads/google-ads.service.js';
import { GoogleAdsApiService } from '../../google-ads/shared/google-ads-api.service.js';
import { GoogleAdsAuthService } from '../../google-ads/shared/google-ads-auth.service.js';
import { metaService, type MetaService } from '../../meta/meta.service.js';
import { tiktokService, type TikTokService } from '../../tiktok/tiktok.service.js';
import { AdvertisingReconciliationRepository } from './advertising-reconciliation.repository.js';

const DAY_MS = 24 * 60 * 60 * 1_000;
const CATALOG_INTERVAL_MS = 72 * 60 * 60 * 1_000;
const DAILY_JITTER_MS = 60 * 60 * 1_000;
const CATALOG_JITTER_MS = 2 * 60 * 60 * 1_000;
const MANUAL_COOLDOWN_MS = 5 * 60 * 1_000;
const URGENT_DEBOUNCE_MS = 60 * 1_000;
const CLAIM_STALE_MS = 60 * 60 * 1_000;
const ENSURE_INTERVAL_MS = 10 * 60 * 1_000;
const BACKOFF_MS = [15 * 60 * 1_000, 60 * 60 * 1_000, 4 * 60 * 60 * 1_000] as const;

const BILLING_SKIP_CODES = new Set([
  'SUBSCRIPTION_REQUIRED',
  'PLAN_UPGRADE_REQUIRED',
  'PLAN_CHANNEL_SELECTION_REQUIRED',
  'PLAN_AD_CHANNEL_LIMIT',
  'PLAN_CHANNEL_NOT_CONNECTED',
]);

const providers: AdvertisingProvider[] = ['META', 'TIKTOK', 'GOOGLE_ADS'];
const providerValues = new Set<AdvertisingProvider>(providers);

type BillingGuard = Pick<BillingService, 'requireAdProvider'>;
type MetaSync = Pick<MetaService, 'syncInsights' | 'syncCatalogs'>;
type TikTokSync = Pick<TikTokService, 'syncAdsHierarchy' | 'syncInsights' | 'syncCatalogs'>;
type GoogleSync = Pick<GoogleAdsService, 'sync'>;
type GoogleMapping = Pick<GoogleAdsMappingService, 'projectDeterministicFinalUrls'>;
type CacheInvalidator = (storeId: string) => Promise<void>;

function errorCode(error: unknown) {
  return error instanceof AppError ? error.code : 'PAID_MEDIA_RECONCILIATION_FAILED';
}

function errorMessage(error: unknown) {
  if (error instanceof AppError) return `${error.code}: ${error.message}`.slice(0, 1_000);
  if (error instanceof Error) return error.message.slice(0, 1_000);
  return String(error).slice(0, 1_000);
}

function isReauthError(error: unknown) {
  const code = errorCode(error);
  return code.includes('REAUTH') || code.includes('TOKEN_EXPIRED') || code.includes('OAUTH');
}

function stableJitter(storeId: string, provider: AdvertisingProvider, purpose: string, maxMs: number) {
  if (maxMs <= 0) return 0;
  const digest = createHash('sha256').update(`${storeId}:${provider}:${purpose}`).digest();
  return digest.readUInt32BE(0) % maxMs;
}

function initialDaily(storeId: string, provider: AdvertisingProvider, now: Date) {
  return new Date(
    now.getTime() + DAY_MS + stableJitter(storeId, provider, 'daily', DAILY_JITTER_MS),
  );
}

function nextDaily(now: Date) {
  return new Date(now.getTime() + DAY_MS);
}

function initialCatalog(storeId: string, provider: AdvertisingProvider, now: Date) {
  return new Date(
    now.getTime() +
      CATALOG_INTERVAL_MS +
      stableJitter(storeId, provider, 'catalog', CATALOG_JITTER_MS),
  );
}

function nextCatalog(now: Date) {
  return new Date(now.getTime() + CATALOG_INTERVAL_MS);
}

function providerFromInput(value: string): AdvertisingProvider {
  if (!providerValues.has(value as AdvertisingProvider)) {
    throw new AppError('Unsupported advertising provider', 400, 'AD_PROVIDER_INVALID');
  }
  return value as AdvertisingProvider;
}

type ReconciliationResult = {
  dailyRan: boolean;
  catalogRan: boolean;
  urgentRan: boolean;
};

export class AdvertisingReconciliationService {
  private lastEnsureAt = 0;

  constructor(
    private readonly repository: AdvertisingReconciliationRepository,
    private readonly billing: BillingGuard,
    private readonly meta: MetaSync,
    private readonly tiktok: TikTokSync,
    private readonly googleAds: GoogleSync,
    private readonly googleMappings: GoogleMapping,
    private readonly invalidateCaches: CacheInvalidator,
    private readonly now: () => Date = () => new Date(),
  ) {}

  parseProvider(value: string) {
    return providerFromInput(value);
  }

  async ensureSchedules(force = false) {
    const now = this.now();
    if (!force && now.getTime() - this.lastEnsureAt < ENSURE_INTERVAL_MS) return;
    this.lastEnsureAt = now.getTime();

    const connections = await this.repository.listConfiguredActiveConnections();
    await Promise.all(
      connections.map((connection) =>
        this.repository.ensureState({
          storeId: connection.storeId,
          provider: connection.provider,
          nextDailyAt: initialDaily(connection.storeId, connection.provider, now),
          nextCatalogAt: connection.catalogConfigured
            ? initialCatalog(connection.storeId, connection.provider, now)
            : null,
          connectionUpdatedAt: connection.updatedAt,
        }),
      ),
    );
  }

  private async ensureStoreSchedules(storeId: string) {
    const now = this.now();
    const snapshots = await Promise.all(
      providers.map(async (provider) => ({
        provider,
        connection: await this.repository.connectionSnapshot(storeId, provider),
      })),
    );
    await Promise.all(
      snapshots
        .filter(({ connection }) => connection.status === 'ACTIVE' && connection.configured)
        .map(({ provider, connection }) =>
          this.repository.ensureState({
            storeId,
            provider,
            nextDailyAt: initialDaily(storeId, provider, now),
            nextCatalogAt: connection.catalogConfigured
              ? initialCatalog(storeId, provider, now)
              : null,
            connectionUpdatedAt: connection.updatedAt,
          }),
        ),
    );
  }

  async status(storeId: string) {
    await this.ensureStoreSchedules(storeId);
    const states = await this.repository.listStates(storeId);
    return states.map((state) => ({
      id: state.id,
      provider: state.provider,
      status: state.status,
      nextDailyAt: state.nextDailyAt,
      nextCatalogAt: state.nextCatalogAt,
      manualRequestedAt: state.manualRequestedAt,
      urgentAt: state.urgentAt,
      urgentKinds: state.urgentKinds,
      lastStartedAt: state.lastStartedAt,
      lastSucceededAt: state.lastSucceededAt,
      lastCatalogSucceededAt: state.lastCatalogSucceededAt,
      retryAt: state.retryAt,
      failureCount: state.failureCount,
      suspendedReason: state.suspendedReason,
      lastError: state.lastError,
    }));
  }

  async requestManual(storeId: string, rawProvider: string) {
    const provider = providerFromInput(rawProvider);
    await this.billing.requireAdProvider(storeId, provider);
    const connection = await this.repository.connectionSnapshot(storeId, provider);
    if (connection.status !== 'ACTIVE') {
      throw new AppError(
        'Reconnect this advertising provider before syncing.',
        409,
        'AD_PROVIDER_REAUTH_REQUIRED',
        { provider, status: connection.status },
      );
    }
    if (!connection.configured) {
      throw new AppError(
        'Configure at least one advertising account before syncing.',
        409,
        'AD_PROVIDER_NOT_CONFIGURED',
        { provider },
      );
    }

    const now = this.now();
    const schedule = await this.repository.ensureState({
      storeId,
      provider,
      nextDailyAt: initialDaily(storeId, provider, now),
      nextCatalogAt: connection.catalogConfigured ? initialCatalog(storeId, provider, now) : null,
      connectionUpdatedAt: connection.updatedAt,
    });
    if (schedule.status === 'SUSPENDED') {
      throw new AppError(
        'Reconnect this advertising provider before syncing.',
        409,
        'AD_PROVIDER_REAUTH_REQUIRED',
        { provider, reason: schedule.suspendedReason },
      );
    }

    const result = await this.repository.requestManual(storeId, provider, now, MANUAL_COOLDOWN_MS);
    if (result.kind === 'MISSING') {
      throw new AppError('Advertising reconciliation state is unavailable', 503, 'AD_SYNC_STATE_MISSING');
    }
    if (result.kind === 'COOLDOWN') {
      return {
        provider,
        status: 'COOLDOWN' as const,
        reconciliationId: result.stateId,
        retryAt: result.retryAt,
      };
    }
    return {
      provider,
      status: result.kind,
      reconciliationId: result.stateId,
      ...(result.kind === 'QUEUED' ? { queuedAt: result.queuedAt } : {}),
    };
  }

  async markTikTokUrgent(storeId: string, kinds: string[]) {
    const connection = await this.repository.connectionSnapshot(storeId, 'TIKTOK');
    if (connection.status !== 'ACTIVE' || !connection.configured) return null;
    const now = this.now();
    await this.repository.ensureState({
      storeId,
      provider: 'TIKTOK',
      nextDailyAt: initialDaily(storeId, 'TIKTOK', now),
      nextCatalogAt: connection.catalogConfigured ? initialCatalog(storeId, 'TIKTOK', now) : null,
      connectionUpdatedAt: connection.updatedAt,
    });
    return this.repository.markUrgent(
      storeId,
      'TIKTOK',
      kinds,
      new Date(now.getTime() + URGENT_DEBOUNCE_MS),
    );
  }

  async processDue(limit = 2) {
    await this.ensureSchedules();
    const now = this.now();
    const claimToken = randomUUID();
    const states = await this.repository.claimDue(
      Math.max(1, Math.min(limit, 2)),
      now,
      new Date(now.getTime() - CLAIM_STALE_MS),
      claimToken,
    );
    const results = await Promise.all(states.map((state) => this.runClaim(state, claimToken)));
    return {
      claimed: states.length,
      succeeded: results.filter((result) => result === 'SUCCEEDED').length,
      skipped: results.filter((result) => result === 'SKIPPED').length,
      failed: results.filter((result) => result === 'FAILED').length,
      suspended: results.filter((result) => result === 'SUSPENDED').length,
    };
  }

  private async runClaim(state: AdvertisingReconciliationState, claimToken: string) {
    const now = this.now();
    const connection = await this.repository.connectionSnapshot(state.storeId, state.provider);
    if (connection.status !== 'ACTIVE' || !connection.configured) {
      await this.repository.suspend({
        id: state.id,
        claimToken,
        reason: connection.status === 'REAUTH_REQUIRED' ? 'REAUTH_REQUIRED' : 'CONNECTION_INACTIVE',
      });
      return 'SUSPENDED' as const;
    }

    try {
      await this.billing.requireAdProvider(state.storeId, state.provider);
    } catch (error) {
      if (error instanceof AppError && BILLING_SKIP_CODES.has(error.code)) {
        await this.repository.completeSkipped({
          id: state.id,
          claimToken,
          nextDailyAt: nextDaily(now),
          nextCatalogAt: connection.catalogConfigured ? nextCatalog(now) : null,
          reason: error.code,
        });
        return 'SKIPPED' as const;
      }
      return this.failClaim(state, claimToken, error);
    }

    try {
      const result = await this.executePlan(state, connection.catalogConfigured, now);
      await this.repository.completeSuccess({
        id: state.id,
        claimToken,
        now,
        ...(result.dailyRan || state.manualRequestedAt ? { nextDailyAt: nextDaily(now) } : {}),
        ...(result.catalogRan ? { nextCatalogAt: nextCatalog(now) } : {}),
        clearManual: state.manualRequestedAt !== null,
        clearUrgent: result.urgentRan,
        catalogSucceeded: result.catalogRan,
      });
      return 'SUCCEEDED' as const;
    } catch (error) {
      if (isReauthError(error)) {
        await this.repository.suspend({ id: state.id, claimToken, reason: errorCode(error) });
        return 'SUSPENDED' as const;
      }
      return this.failClaim(state, claimToken, error);
    }
  }

  private async executePlan(
    state: AdvertisingReconciliationState,
    catalogConfigured: boolean,
    now: Date,
  ): Promise<ReconciliationResult> {
    const manual = state.manualRequestedAt !== null;
    const urgentDue = state.urgentAt !== null && state.urgentAt <= now;
    const dailyDue = state.nextDailyAt !== null && state.nextDailyAt <= now;
    const catalogDue = state.nextCatalogAt !== null && state.nextCatalogAt <= now;
    const urgentKinds = new Set(state.urgentKinds);

    const runDaily = manual || dailyDue;
    const runCatalog =
      catalogConfigured &&
      (manual || catalogDue || (urgentDue && urgentKinds.has('CATALOG')));

    if (state.provider === 'META') {
      if (runDaily) await this.meta.syncInsights(state.storeId);
      if (runCatalog) await this.meta.syncCatalogs(state.storeId);
    } else if (state.provider === 'TIKTOK') {
      const hierarchy = runDaily || (urgentDue && urgentKinds.has('HIERARCHY'));
      const insights = runDaily || (urgentDue && urgentKinds.has('INSIGHTS'));
      if (hierarchy) await this.tiktok.syncAdsHierarchy(state.storeId);
      if (insights) {
        if (urgentDue && !runDaily) await this.tiktok.syncInsights(state.storeId, 2);
        else await this.tiktok.syncInsights(state.storeId);
      }
      if (runCatalog) await this.tiktok.syncCatalogs(state.storeId);
    } else if (runDaily) {
      await this.googleAds.sync(state.storeId, 'INCREMENTAL');
      await this.googleMappings.projectDeterministicFinalUrls(state.storeId);
      await this.invalidateCaches(state.storeId);
    }

    return {
      dailyRan: runDaily,
      catalogRan: runCatalog,
      urgentRan: urgentDue,
    };
  }

  private async failClaim(
    state: AdvertisingReconciliationState,
    claimToken: string,
    error: unknown,
  ) {
    const now = this.now();
    const failureCount = state.failureCount + 1;
    const message = errorMessage(error);
    if (failureCount <= BACKOFF_MS.length) {
      await this.repository.markBackoff({
        id: state.id,
        claimToken,
        failureCount,
        retryAt: new Date(now.getTime() + BACKOFF_MS[failureCount - 1]!),
        error: message,
      });
      return 'FAILED' as const;
    }

    const connection = await this.repository.connectionSnapshot(state.storeId, state.provider);
    await this.repository.exhaustFailure({
      id: state.id,
      claimToken,
      nextDailyAt: nextDaily(now),
      nextCatalogAt: connection.catalogConfigured ? nextCatalog(now) : null,
      error: message,
    });
    return 'FAILED' as const;
  }
}

const googleRepository = new GoogleAdsRepository();
const googleApi = new GoogleAdsApiService();
const googleAuth = new GoogleAdsAuthService(googleRepository, googleApi);
const googleService = new GoogleAdsService(googleRepository, googleAuth, googleApi);

export const advertisingReconciliationService = new AdvertisingReconciliationService(
  new AdvertisingReconciliationRepository(),
  billingService,
  metaService,
  tiktokService,
  googleService,
  googleAdsMappingService,
  invalidateStoreDecisionCaches,
);
