import { AppError } from '../../errors/app-error.js';
import { pagination } from '../analytics/analytics.shared.js';
import { resolveAnalyticsWindows } from '../analytics/analytics.dates.js';
import { percentChange } from '../analytics/analytics.metrics.js';
import { IntelligenceContextReadRepository } from '../intelligence/intelligence-context.read.repository.js';
import {
  unifiedAdvertisingScopeService,
  type UnifiedAdvertisingScopeService,
} from './unified-advertising-scope.service.js';
import type { UnifiedAdvertisingListQuery } from './unified-advertising.schema.js';
import {
  UnifiedPaidEntityRepository,
  type UnifiedPaidEntityIdentity,
  type UnifiedPaidEntityKind,
  type UnifiedPaidEntityMetricRow,
} from './unified-paid-entity.repository.js';

export type PaidEntityConfidence = 'LOW' | 'MEDIUM' | 'HIGH';

export interface PaidEntityMetrics {
  [key: string]: unknown;
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
}

const MIN_SIGNAL_IMPRESSIONS = 100;
const HIGH_CONFIDENCE_IMPRESSIONS = 1000;

function aggregate(rows: UnifiedPaidEntityMetricRow[]): PaidEntityMetrics {
  if (rows.length === 0) {
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
    };
  }
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
  };
}

function relative(current: number | null, comparison: number | null) {
  if (current === null || comparison === null || comparison === 0) return null;
  return (current - comparison) / Math.abs(comparison);
}

export function unifiedPaidEntityConfidence(
  current: PaidEntityMetrics,
  comparison: PaidEntityMetrics,
): PaidEntityConfidence {
  if (
    !current.evidenceAvailable ||
    current.sourceRows === 0 ||
    (current.impressions ?? 0) < MIN_SIGNAL_IMPRESSIONS
  ) {
    return 'LOW';
  }
  if (
    !comparison.evidenceAvailable ||
    comparison.sourceRows === 0 ||
    (comparison.impressions ?? 0) < MIN_SIGNAL_IMPRESSIONS ||
    (current.impressions ?? 0) < HIGH_CONFIDENCE_IMPRESSIONS ||
    (comparison.impressions ?? 0) < HIGH_CONFIDENCE_IMPRESSIONS
  ) {
    return 'MEDIUM';
  }
  return 'HIGH';
}

export function unifiedPaidEntitySignals(
  current: PaidEntityMetrics,
  comparison: PaidEntityMetrics,
) {
  const values: Array<{
    code: string;
    severity: 'INFO' | 'WARNING' | 'HIGH';
    conclusion: string;
    evidence: Record<string, number | null>;
  }> = [];
  if (!current.evidenceAvailable) {
    values.push({
      code: 'INSUFFICIENT_CURRENT_EVIDENCE',
      severity: 'WARNING',
      conclusion: 'Current-period provider evidence is unavailable.',
      evidence: { sourceRows: current.sourceRows },
    });
    return values;
  }

  const currentImpressions = current.impressions ?? 0;
  const comparisonImpressions = comparison.impressions ?? 0;
  if (currentImpressions < MIN_SIGNAL_IMPRESSIONS) {
    values.push({
      code: 'LOW_DELIVERY_INSUFFICIENT_EVIDENCE',
      severity: 'INFO',
      conclusion: 'Delivery is too low for a strong efficiency conclusion.',
      evidence: { impressions: current.impressions, clicks: current.clicks },
    });
    return values;
  }

  if ((current.spend ?? 0) > 0 && current.providerConversions === 0) {
    values.push({
      code: 'NO_CONVERSION_SPEND',
      severity: 'WARNING',
      conclusion: 'Provider-reported spend is present with zero reported conversions in the current period.',
      evidence: { spend: current.spend, providerConversions: current.providerConversions },
    });
  }

  // Comparison-based deterioration requires enough delivery in both periods. Without this guard,
  // a handful of impressions can produce dramatic CTR/CPC/ROAS percentages that look actionable
  // despite being statistically thin. Missing or low comparison delivery remains a limitation,
  // not a deterioration claim.
  if (
    !comparison.evidenceAvailable ||
    comparison.sourceRows === 0 ||
    comparisonImpressions < MIN_SIGNAL_IMPRESSIONS
  ) {
    return values;
  }

  const spendDelta = relative(current.spend, comparison.spend);
  const roasDelta = relative(current.providerRoas, comparison.providerRoas);
  if (spendDelta !== null && roasDelta !== null && spendDelta >= 0.15 && roasDelta <= -0.15) {
    values.push({
      code: 'SPEND_UP_EFFICIENCY_DOWN',
      severity: roasDelta <= -0.3 ? 'HIGH' : 'WARNING',
      conclusion: 'Provider spend increased while provider-reported ROAS deteriorated.',
      evidence: { spendChange: spendDelta, providerRoasChange: roasDelta },
    });
  }
  const cpcDelta = relative(current.cpc, comparison.cpc);
  if (cpcDelta !== null && cpcDelta >= 0.2) {
    values.push({
      code: 'CPC_DETERIORATION',
      severity: cpcDelta >= 0.4 ? 'HIGH' : 'WARNING',
      conclusion: 'Cost per click deteriorated versus the comparison period.',
      evidence: { cpcChange: cpcDelta, currentCpc: current.cpc, comparisonCpc: comparison.cpc },
    });
  }
  const ctrDelta = relative(current.ctr, comparison.ctr);
  if (ctrDelta !== null && ctrDelta <= -0.2) {
    values.push({
      code: 'CTR_DETERIORATION',
      severity: ctrDelta <= -0.4 ? 'HIGH' : 'WARNING',
      conclusion: 'Click-through rate deteriorated versus the comparison period.',
      evidence: { ctrChange: ctrDelta, currentCtr: current.ctr, comparisonCtr: comparison.ctr },
    });
  }
  const conversionsDelta = relative(
    current.providerConversions,
    comparison.providerConversions,
  );
  if (spendDelta !== null && conversionsDelta !== null && spendDelta > 0.1 && conversionsDelta < -0.1) {
    values.push({
      code: 'CONVERSIONS_DOWN_SPEND_UP',
      severity: 'HIGH',
      conclusion: 'Provider-reported conversions fell while spend increased.',
      evidence: { spendChange: spendDelta, providerConversionsChange: conversionsDelta },
    });
  }
  if (
    currentImpressions >= HIGH_CONFIDENCE_IMPRESSIONS &&
    comparisonImpressions >= HIGH_CONFIDENCE_IMPRESSIONS &&
    current.providerRoas !== null &&
    current.providerConversions !== null &&
    current.providerConversions >= 5 &&
    comparison.providerRoas !== null &&
    current.providerRoas >= comparison.providerRoas * 1.15
  ) {
    values.push({
      code: 'STRONG_PROVIDER_EFFICIENCY',
      severity: 'INFO',
      conclusion: 'Provider-reported efficiency improved with a non-trivial conversion and delivery sample.',
      evidence: {
        providerRoas: current.providerRoas,
        comparisonProviderRoas: comparison.providerRoas,
        providerConversions: current.providerConversions,
      },
    });
  }
  if (spendDelta !== null && Math.abs(spendDelta) >= 0.5) {
    values.push({
      code: 'SUDDEN_DELIVERY_CHANGE',
      severity: 'WARNING',
      conclusion: 'Spend changed by at least 50% versus the comparison period.',
      evidence: { spendChange: spendDelta },
    });
  }
  return values;
}

function changes(current: PaidEntityMetrics, comparison: PaidEntityMetrics) {
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
  };
}

function item(
  identity: UnifiedPaidEntityIdentity,
  rows: UnifiedPaidEntityMetricRow[],
) {
  const currency = identity.account.currency;
  const current = aggregate(
    rows.filter(
      (row) =>
        row.entityId === identity.id && row.period === 'CURRENT' && row.currency === currency,
    ),
  );
  const comparison = aggregate(
    rows.filter(
      (row) =>
        row.entityId === identity.id &&
        row.period === 'COMPARISON' &&
        row.currency === currency,
    ),
  );
  return {
    entity: identity,
    currency,
    current,
    comparison,
    change: changes(current, comparison),
    intelligence: {
      confidence: unifiedPaidEntityConfidence(current, comparison),
      signals: unifiedPaidEntitySignals(current, comparison),
      limitations: [
        ...(!currency ? ['ACCOUNT_CURRENCY_MISSING'] : []),
        ...(!current.evidenceAvailable ? ['CURRENT_PROVIDER_EVIDENCE_MISSING'] : []),
        ...(!comparison.evidenceAvailable ? ['COMPARISON_PROVIDER_EVIDENCE_MISSING'] : []),
        ...(comparison.evidenceAvailable && (comparison.impressions ?? 0) < MIN_SIGNAL_IMPRESSIONS
          ? ['COMPARISON_DELIVERY_INSUFFICIENT']
          : []),
      ],
    },
  };
}

export class UnifiedPaidEntityService {
  constructor(
    private readonly scope: UnifiedAdvertisingScopeService = unifiedAdvertisingScopeService,
    private readonly repository: UnifiedPaidEntityRepository = new UnifiedPaidEntityRepository(),
    private readonly context: IntelligenceContextReadRepository =
      new IntelligenceContextReadRepository(),
  ) {}

  async list(
    storeId: string,
    kind: UnifiedPaidEntityKind,
    query: UnifiedAdvertisingListQuery,
    now = new Date(),
  ) {
    const context = await this.context.getContext(storeId);
    if (!context) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');
    const windows = resolveAnalyticsWindows(
      { from: query.from, to: query.to, days: query.days },
      context.ianaTimezone,
      now,
    );
    const scope = await this.scope.resolve({
      storeId,
      provider: query.provider,
      accountId: query.accountId,
      currency: query.currency,
    });
    const page = await this.repository.page({
      accounts: scope.accounts,
      kind,
      page: query.page,
      limit: query.limit,
    });
    const rows = await this.repository.metrics({
      kind,
      entityIds: page.items.map((entity) => entity.id),
      currentFrom: windows.current.metaFrom,
      currentTo: windows.current.metaTo,
      comparisonFrom: windows.comparison.metaFrom,
      comparisonTo: windows.comparison.metaTo,
      currency: query.currency,
    });
    return {
      schemaVersion: '2.0',
      entityKind: kind,
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
      attributionMeaning:
        'Conversions, conversion value and ROAS are provider-reported attribution evidence, not Shopify revenue.',
      items: page.items.map((identity) => item(identity, rows)),
      pagination: pagination(query.page, query.limit, page.total),
      capabilities: {
        groupVocabulary: 'GROUP',
        groupKinds: ['AD_SET', 'AD_GROUP', 'ASSET_GROUP'],
        providerSpecificCreativeEvidence: true,
        pmaxFakeAdsCreated: false,
      },
    };
  }
}

export const unifiedPaidEntityService = new UnifiedPaidEntityService();
