import { AppError } from '../../errors/app-error.js';
import { CommerceAnalyticsReadRepository } from '../analytics/commerce-analytics.read.repository.js';
import { CommerceAnalyticsService } from '../analytics/commerce-analytics.service.js';
import { resolveAnalyticsWindows } from '../analytics/analytics.dates.js';
import { percentChange } from '../analytics/analytics.metrics.js';
import { AnalyticsRepository } from '../analytics/analytics.repository.js';
import {
  unifiedAdvertisingScopeService,
  type UnifiedAdvertisingScopeService,
} from './unified-advertising-scope.service.js';
import type { UnifiedAdvertisingRangeQuery } from './unified-advertising.schema.js';
import {
  UnifiedAdvertisingRepository,
  type UnifiedAdvertisingAccountRow,
  type UnifiedAdvertisingMetricRow,
  type UnifiedAdvertisingPeriod,
  type UnifiedAdvertisingProvider,
  type UnifiedProviderConnectionState,
} from './unified-advertising.repository.js';

export type UnifiedEvidenceConfidence = 'LOW' | 'MEDIUM' | 'HIGH';
export type UnifiedDataQualityStatus = 'HEALTHY' | 'WARNING' | 'BLOCKED';

export interface UnifiedDataQualityItem {
  code: string;
  status: UnifiedDataQualityStatus;
  surface: string;
  message: string;
  provider?: UnifiedAdvertisingProvider;
  accountId?: string;
  metrics?: Record<string, unknown>;
}

export interface UnifiedAdvertisingMetrics {
  evidenceAvailable: boolean;
  sourceRows: number;
  spend: number | null;
  impressions: number | null;
  clicks: number | null;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  providerConversions: number | null;
  providerConversionValue: number | null;
  providerRoas: number | null;
  reach: null;
  latestSyncedAt: Date | null;
}

const PROVIDERS: UnifiedAdvertisingProvider[] = ['META', 'TIKTOK', 'GOOGLE_ADS'];
const STALE_SYNC_HOURS = 48;

function emptyMetrics(): UnifiedAdvertisingMetrics {
  return {
    evidenceAvailable: false,
    sourceRows: 0,
    spend: null,
    impressions: null,
    clicks: null,
    ctr: null,
    cpc: null,
    cpm: null,
    providerConversions: null,
    providerConversionValue: null,
    providerRoas: null,
    reach: null,
    latestSyncedAt: null,
  };
}

export function aggregateUnifiedAdvertisingMetrics(
  rows: UnifiedAdvertisingMetricRow[],
): UnifiedAdvertisingMetrics {
  if (rows.length === 0) return emptyMetrics();
  const spend = rows.reduce((sum, row) => sum + row.spend, 0);
  const impressions = rows.reduce((sum, row) => sum + row.impressions, 0);
  const clicks = rows.reduce((sum, row) => sum + row.clicks, 0);
  const conversionRows = rows.filter((row) => row.conversions !== null);
  const valueRows = rows.filter((row) => row.conversionValue !== null);
  const providerConversions =
    conversionRows.length > 0
      ? conversionRows.reduce((sum, row) => sum + (row.conversions ?? 0), 0)
      : null;
  const providerConversionValue =
    valueRows.length > 0
      ? valueRows.reduce((sum, row) => sum + (row.conversionValue ?? 0), 0)
      : null;
  const latestSyncedAt = rows.reduce<Date | null>(
    (latest, row) =>
      row.latestSyncedAt && (!latest || row.latestSyncedAt > latest) ? row.latestSyncedAt : latest,
    null,
  );
  return {
    evidenceAvailable: true,
    sourceRows: rows.reduce((sum, row) => sum + row.sourceRows, 0),
    spend,
    impressions,
    clicks,
    ctr: impressions > 0 ? clicks / impressions : null,
    cpc: clicks > 0 ? spend / clicks : null,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : null,
    providerConversions,
    providerConversionValue,
    providerRoas:
      providerConversionValue !== null && spend > 0 ? providerConversionValue / spend : null,
    reach: null,
    latestSyncedAt,
  };
}

function metricChange(
  current: UnifiedAdvertisingMetrics,
  comparison: UnifiedAdvertisingMetrics,
) {
  return {
    spend: percentChange(current.spend, comparison.spend),
    impressions: percentChange(current.impressions, comparison.impressions),
    clicks: percentChange(current.clicks, comparison.clicks),
    ctr: percentChange(current.ctr, comparison.ctr),
    cpc: percentChange(current.cpc, comparison.cpc),
    cpm: percentChange(current.cpm, comparison.cpm),
    providerConversions: percentChange(
      current.providerConversions,
      comparison.providerConversions,
    ),
    providerConversionValue: percentChange(
      current.providerConversionValue,
      comparison.providerConversionValue,
    ),
    providerRoas: percentChange(current.providerRoas, comparison.providerRoas),
    reach: null,
  };
}

function ageHours(value: Date | null, now: Date): number | null {
  if (!value) return null;
  return Math.max(0, (now.getTime() - value.getTime()) / 3_600_000);
}

function confidence(
  items: UnifiedDataQualityItem[],
  comparisonRows: number,
): UnifiedEvidenceConfidence {
  if (items.some((item) => item.status === 'BLOCKED')) return 'LOW';
  if (items.some((item) => item.status === 'WARNING') || comparisonRows === 0) return 'MEDIUM';
  return 'HIGH';
}

export class UnifiedAdvertisingService {
  private readonly commerce: CommerceAnalyticsService;

  constructor(
    private readonly repository: UnifiedAdvertisingRepository = new UnifiedAdvertisingRepository(),
    private readonly analyticsRepository: AnalyticsRepository = new AnalyticsRepository(),
    commerceReadRepository: CommerceAnalyticsReadRepository = new CommerceAnalyticsReadRepository(),
    private readonly scope: UnifiedAdvertisingScopeService = unifiedAdvertisingScopeService,
  ) {
    this.commerce = new CommerceAnalyticsService(analyticsRepository, commerceReadRepository);
  }

  async read(storeId: string, query: UnifiedAdvertisingRangeQuery, now = new Date()) {
    const store = await this.analyticsRepository.getStoreContext(storeId);
    if (!store) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    const windows = resolveAnalyticsWindows(
      { from: query.from, to: query.to, days: query.days },
      store.ianaTimezone,
      now,
    );
    const scoped = await this.scope.resolve({
      storeId,
      provider: query.provider,
      accountId: query.accountId,
      currency: query.currency,
    });
    const scopedAccounts = scoped.accounts;

    const [rows, counts, commerce, profitabilityBase] = await Promise.all([
      this.repository.metricRows({
        accounts: scopedAccounts,
        currentFrom: windows.current.metaFrom,
        currentTo: windows.current.metaTo,
        comparisonFrom: windows.comparison.metaFrom,
        comparisonTo: windows.comparison.metaTo,
      }),
      this.repository.entityCounts(scopedAccounts.map((account) => account.id)),
      this.commerce.summary(store, windows),
      this.commerce.profitabilityBase(store, windows),
    ]);

    const quality = this.dataQuality({
      states: scoped.states,
      allSelectedAccounts: scoped.allSelectedAccounts,
      scopedAccounts,
      rows,
      requestedProvider: query.provider,
      requestedCurrency: query.currency,
      now,
    });
    const providerEvidence = this.providerEvidence(scopedAccounts, rows);
    const accountEvidence = this.accountEvidence(scopedAccounts, rows);
    const blendedEconomics = this.blendedEconomics({
      storeCurrency: store.currencyCode,
      accounts: scopedAccounts,
      rows,
      commerce,
      profitabilityBase,
    });
    const comparisonRows = rows
      .filter((row) => row.period === 'COMPARISON')
      .reduce((sum, row) => sum + row.sourceRows, 0);

    return {
      schemaVersion: '2.0',
      truthModel: {
        commerce: 'SHOPIFY',
        paidMedia: 'PROVIDER_REPORTED_ATTRIBUTION',
        storefront: 'STRIDE_PIXEL_FIRST_PARTY_OBSERVED',
        intelligence: 'DETERMINISTIC',
      },
      filters: {
        provider: query.provider,
        accountId: query.accountId ?? null,
        currency: query.currency ?? null,
      },
      window: {
        current: { from: windows.current.fromDate, to: windows.current.toDate },
        comparison: { from: windows.comparison.fromDate, to: windows.comparison.toDate },
        days: windows.days,
      },
      accounts: scopedAccounts,
      counts,
      providerEvidence,
      accountEvidence,
      commerce,
      blendedEconomics,
      dataQuality: {
        confidence: confidence(quality, comparisonRows),
        items: quality,
      },
      capabilities: {
        reach: {
          available: false,
          reason:
            'Daily provider reach is non-additive; no trustworthy cross-period deduplication exists.',
        },
        providerAttribution: {
          canSumAsUniqueRevenue: false,
          reason: 'Provider conversion values are attribution evidence and are not Shopify revenue.',
        },
      },
      methodology: {
        paidMedia:
          'Canonical AdvertisingDailyMetric facts; Meta/TikTok use AD-level facts and Google uses ACCOUNT-level facts to avoid inventing PMax ads or double-counting hierarchy levels.',
        ctr: 'clicks / impressions',
        cpc: 'spend / clicks',
        cpm: 'spend / impressions * 1000',
        providerRoas: 'provider-attributed conversion value / provider spend',
        blendedMer: 'Shopify net order value / complete same-currency paid-media spend',
        adSpendRatio: 'complete same-currency paid-media spend / Shopify net order value',
        contributionAfterAdvertising:
          'Shopify contribution before ads - complete same-currency paid-media spend',
      },
    };
  }

  private providerEvidence(
    accounts: UnifiedAdvertisingAccountRow[],
    rows: UnifiedAdvertisingMetricRow[],
  ) {
    const values: Array<{
      provider: UnifiedAdvertisingProvider;
      currency: string | null;
      accountIds: string[];
      current: UnifiedAdvertisingMetrics;
      comparison: UnifiedAdvertisingMetrics;
      change: ReturnType<typeof metricChange>;
    }> = [];
    for (const provider of PROVIDERS) {
      const providerAccounts = accounts.filter((account) => account.provider === provider);
      if (providerAccounts.length === 0) continue;
      const accountIds = new Set(providerAccounts.map((account) => account.id));
      const currencies = new Set<string | null>([
        ...providerAccounts.map((account) => account.currency),
        ...rows.filter((row) => accountIds.has(row.accountId)).map((row) => row.currency),
      ]);
      for (const currency of currencies) {
        const current = aggregateUnifiedAdvertisingMetrics(
          rows.filter(
            (row) =>
              row.period === 'CURRENT' &&
              accountIds.has(row.accountId) &&
              row.currency === currency,
          ),
        );
        const comparison = aggregateUnifiedAdvertisingMetrics(
          rows.filter(
            (row) =>
              row.period === 'COMPARISON' &&
              accountIds.has(row.accountId) &&
              row.currency === currency,
          ),
        );
        values.push({
          provider,
          currency,
          accountIds: providerAccounts.map((account) => account.id),
          current,
          comparison,
          change: metricChange(current, comparison),
        });
      }
    }
    return values;
  }

  private accountEvidence(
    accounts: UnifiedAdvertisingAccountRow[],
    rows: UnifiedAdvertisingMetricRow[],
  ) {
    return accounts.map((account) => {
      const current = aggregateUnifiedAdvertisingMetrics(
        rows.filter(
          (row) =>
            row.accountId === account.id &&
            row.period === 'CURRENT' &&
            row.currency === account.currency,
        ),
      );
      const comparison = aggregateUnifiedAdvertisingMetrics(
        rows.filter(
          (row) =>
            row.accountId === account.id &&
            row.period === 'COMPARISON' &&
            row.currency === account.currency,
        ),
      );
      return {
        account,
        current,
        comparison,
        change: metricChange(current, comparison),
      };
    });
  }

  private blendedEconomics(input: {
    storeCurrency: string;
    accounts: UnifiedAdvertisingAccountRow[];
    rows: UnifiedAdvertisingMetricRow[];
    commerce: Awaited<ReturnType<CommerceAnalyticsService['summary']>>;
    profitabilityBase: Awaited<ReturnType<CommerceAnalyticsService['profitabilityBase']>>;
  }) {
    const compatibleAccounts = input.accounts.filter(
      (account) => account.currency === input.storeCurrency,
    );
    const period = (name: UnifiedAdvertisingPeriod) => {
      const periodRows = input.rows.filter(
        (row) => row.period === name && row.currency === input.storeCurrency,
      );
      const rowAccountIds = new Set(periodRows.map((row) => row.accountId));
      const missingAccountIds = compatibleAccounts
        .filter((account) => !rowAccountIds.has(account.id))
        .map((account) => account.id);
      const evidenceAvailable =
        compatibleAccounts.length > 0 && missingAccountIds.length === 0;
      const metrics = aggregateUnifiedAdvertisingMetrics(periodRows);
      return {
        evidenceAvailable,
        missingAccountIds,
        spend: evidenceAvailable ? metrics.spend : null,
      };
    };
    const currentSpend = period('CURRENT');
    const comparisonSpend = period('COMPARISON');
    const economics = (
      spendEvidence: ReturnType<typeof period>,
      commerceValue: typeof input.commerce.current,
      profitability: typeof input.profitabilityBase.current,
    ) => {
      const spend = spendEvidence.spend;
      return {
        compatiblePaidSpend: spend,
        mer:
          spendEvidence.evidenceAvailable && spend !== null && spend > 0
            ? commerceValue.netOrderValue / spend
            : null,
        adSpendRatio:
          spendEvidence.evidenceAvailable && spend !== null && commerceValue.netOrderValue > 0
            ? spend / commerceValue.netOrderValue
            : null,
        contributionBeforeAdvertising: profitability.contributionBeforeAds,
        contributionAfterAdvertising:
          spendEvidence.evidenceAvailable &&
          spend !== null &&
          profitability.contributionBeforeAds !== null
            ? profitability.contributionBeforeAds - spend
            : null,
        evidenceAvailable: spendEvidence.evidenceAvailable,
        missingAccountIds: spendEvidence.missingAccountIds,
      };
    };
    const current = economics(currentSpend, input.commerce.current, input.profitabilityBase.current);
    const comparison = economics(
      comparisonSpend,
      input.commerce.comparison,
      input.profitabilityBase.comparison,
    );
    return {
      currency: input.storeCurrency,
      current,
      comparison,
      change: {
        compatiblePaidSpend: percentChange(
          current.compatiblePaidSpend,
          comparison.compatiblePaidSpend,
        ),
        mer: percentChange(current.mer, comparison.mer),
        adSpendRatio: percentChange(current.adSpendRatio, comparison.adSpendRatio),
        contributionAfterAdvertising: percentChange(
          current.contributionAfterAdvertising,
          comparison.contributionAfterAdvertising,
        ),
      },
    };
  }

  private dataQuality(input: {
    states: UnifiedProviderConnectionState[];
    allSelectedAccounts: UnifiedAdvertisingAccountRow[];
    scopedAccounts: UnifiedAdvertisingAccountRow[];
    rows: UnifiedAdvertisingMetricRow[];
    requestedProvider: string;
    requestedCurrency?: string;
    now: Date;
  }): UnifiedDataQualityItem[] {
    const items: UnifiedDataQualityItem[] = [];
    const consideredStates = input.states.filter(
      (state) => input.requestedProvider === 'ALL' || state.provider === input.requestedProvider,
    );
    for (const state of consideredStates) {
      if (
        state.status === null ||
        state.status === 'DISCONNECTED' ||
        state.status === 'UNINSTALLED'
      ) {
        items.push({
          code: 'PROVIDER_DISCONNECTED',
          status: 'WARNING',
          surface: 'PAID_MEDIA',
          provider: state.provider,
          message: `${state.provider} is not connected; no evidence from that provider is included.`,
        });
        continue;
      }
      if (state.status !== 'ACTIVE') {
        items.push({
          code: 'PROVIDER_CONNECTION_BLOCKED',
          status: 'BLOCKED',
          surface: 'PAID_MEDIA',
          provider: state.provider,
          message: `${state.provider} connection is ${state.status}.`,
        });
      }
      if (state.selectedExternalIds.length === 0) {
        items.push({
          code: 'ACCOUNT_NOT_SELECTED',
          status: 'WARNING',
          surface: 'PAID_MEDIA',
          provider: state.provider,
          message: `${state.provider} has no selected advertising account.`,
        });
      }
      const age = ageHours(state.lastSyncedAt, input.now);
      if (age !== null && age > STALE_SYNC_HOURS) {
        items.push({
          code: 'STALE_SYNC',
          status: 'WARNING',
          surface: 'PAID_MEDIA',
          provider: state.provider,
          message: `${state.provider} advertising evidence is stale.`,
          metrics: { ageHours: age, thresholdHours: STALE_SYNC_HOURS },
        });
      }
      if (state.lastSyncStatus === 'PARTIAL' || state.lastSyncStatus === 'FAILED') {
        items.push({
          code: state.lastSyncStatus === 'PARTIAL' ? 'PARTIAL_SYNC' : 'FAILED_SYNC',
          status: state.lastSyncStatus === 'FAILED' ? 'BLOCKED' : 'WARNING',
          surface: 'PAID_MEDIA',
          provider: state.provider,
          message: `${state.provider} latest sync status is ${state.lastSyncStatus}.`,
        });
      }
      const canonicalExternalIds = new Set(
        input.allSelectedAccounts
          .filter((account) => account.provider === state.provider)
          .map((account) => account.providerEntityId),
      );
      const missingCanonicalAccounts = state.selectedExternalIds.filter(
        (externalId) => !canonicalExternalIds.has(externalId),
      );
      if (missingCanonicalAccounts.length > 0) {
        items.push({
          code: 'SELECTED_ACCOUNT_EVIDENCE_MISSING',
          status: 'BLOCKED',
          surface: 'PAID_MEDIA',
          provider: state.provider,
          message: 'A selected provider account has no canonical AdvertisingAccount evidence.',
          metrics: { selectedExternalIds: missingCanonicalAccounts },
        });
      }
    }

    if (input.requestedCurrency && input.scopedAccounts.length === 0) {
      items.push({
        code: 'CURRENCY_MISMATCH',
        status: 'WARNING',
        surface: 'PAID_MEDIA',
        message: `No selected advertising account uses ${input.requestedCurrency}.`,
      });
    }
    for (const account of input.scopedAccounts) {
      for (const period of ['CURRENT', 'COMPARISON'] as const) {
        if (!input.rows.some((row) => row.accountId === account.id && row.period === period)) {
          items.push({
            code: 'MISSING_PAID_MEDIA_EVIDENCE',
            status: period === 'CURRENT' ? 'BLOCKED' : 'WARNING',
            surface: 'PAID_MEDIA',
            provider: account.provider,
            accountId: account.id,
            message: `${period.toLowerCase()}-period advertising evidence is unavailable for the selected account; missing is not treated as zero.`,
          });
        }
      }
      if (!account.currency) {
        items.push({
          code: 'MISSING_ACCOUNT_CURRENCY',
          status: 'BLOCKED',
          surface: 'BLENDED_ECONOMICS',
          provider: account.provider,
          accountId: account.id,
          message: 'Account currency is missing, so its spend cannot enter blended economics.',
        });
      }
    }
    items.push({
      code: 'UNAVAILABLE_REACH',
      status: 'WARNING',
      surface: 'PAID_MEDIA',
      message:
        'Period reach is unavailable because daily reach cannot be safely summed or deduplicated.',
    });
    return items;
  }
}

export const unifiedAdvertisingService = new UnifiedAdvertisingService();
