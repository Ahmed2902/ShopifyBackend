import type {
  CampaignRole,
  CandidateDecision,
  CreativeFatigue,
  EvidenceConfidence,
  FinancialDecisionContext,
  InventoryRisk,
  MetricWindow,
  NormalizedDailyMetrics,
} from './intelligence.types.js';

const WINDOWS = [1, 3, 7, 14, 30] as const;

function safeDivide(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function round(value: number | null, digits = 4): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function startOfUtcDay(date: Date): Date {
  const value = new Date(date);
  value.setUTCHours(0, 0, 0, 0);
  return value;
}

export function aggregateMetricWindow(
  rows: NormalizedDailyMetrics[],
  days: (typeof WINDOWS)[number],
  now = new Date(),
): MetricWindow {
  const end = startOfUtcDay(now);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days + 1);
  const selected = rows.filter((row) => row.date >= start && row.date <= end);
  const observedDays = new Set(selected.map((row) => startOfUtcDay(row.date).getTime())).size;

  const spend = selected.reduce((sum, row) => sum + row.spend, 0);
  const impressions = selected.reduce((sum, row) => sum + row.impressions, 0);
  const clicks = selected.reduce((sum, row) => sum + row.clicks, 0);
  const outboundRows = selected.filter((row) => row.outboundClicks !== null);
  const outboundClicks = outboundRows.length
    ? outboundRows.reduce((sum, row) => sum + (row.outboundClicks ?? 0), 0)
    : null;
  const conversions = selected.reduce((sum, row) => sum + row.conversions, 0);
  const conversionValue = selected.reduce((sum, row) => sum + row.conversionValue, 0);
  const reachRows = selected.filter((row) => row.reach !== null);
  const reach = reachRows.length ? reachRows.reduce((sum, row) => sum + (row.reach ?? 0), 0) : null;
  const frequencyWeight = selected.reduce(
    (sum, row) => sum + (row.frequency !== null ? row.impressions : 0),
    0,
  );
  const frequency = frequencyWeight
    ? selected.reduce((sum, row) => sum + (row.frequency ?? 0) * row.impressions, 0) /
      frequencyWeight
    : null;

  return {
    days,
    observedDays,
    spend: round(spend, 2) ?? 0,
    impressions,
    reach,
    clicks,
    outboundClicks,
    conversions: round(conversions, 4) ?? 0,
    conversionValue: round(conversionValue, 2) ?? 0,
    ctr: round(safeDivide(clicks * 100, impressions)),
    cpc: round(safeDivide(spend, clicks), 2),
    cpm: round(safeDivide(spend * 1000, impressions), 2),
    cvr: round(safeDivide(conversions * 100, outboundClicks ?? clicks)),
    cpa: round(safeDivide(spend, conversions), 2),
    roas: round(safeDivide(conversionValue, spend)),
    frequency: round(frequency),
  };
}

export function metricWindows(rows: NormalizedDailyMetrics[], now = new Date()) {
  return Object.fromEntries(
    WINDOWS.map((days) => [days, aggregateMetricWindow(rows, days, now)]),
  ) as Record<(typeof WINDOWS)[number], MetricWindow>;
}

export function classifyCampaignRole(input: {
  name: string;
  objective?: string | null;
  optimizationGoal?: string | null;
  catalogId?: string | null;
}): { role: CampaignRole; evidence: string[] } {
  const text = `${input.name} ${input.objective ?? ''} ${input.optimizationGoal ?? ''}`.toLowerCase();
  const has = (terms: string[]) => terms.some((term) => text.includes(term));

  if (has(['retarget', 'remarket', 'rtg', 're-engage', 'reengage'])) {
    return { role: 'RETARGETING', evidence: ['retargeting signal in name/objective'] };
  }
  if (has(['retention', 'loyalty', 'existing customer', 'repeat customer', 'customer list'])) {
    return { role: 'RETENTION', evidence: ['retention signal in name/objective'] };
  }
  if (input.catalogId || has(['catalog', 'product sales', 'product_sales', 'shopping'])) {
    return {
      role: 'CATALOG',
      evidence: [input.catalogId ? 'catalog is attached' : 'catalog signal in objective'],
    };
  }
  if (has(['launch', 'new product', 'new collection'])) {
    return { role: 'PRODUCT_LAUNCH', evidence: ['product-launch signal in name'] };
  }
  if (has(['awareness', 'brand awareness', 'reach', 'video views'])) {
    return { role: 'BRAND', evidence: ['brand/reach signal in objective'] };
  }
  if (has(['sales', 'conversion', 'purchase', 'traffic', 'prospecting', 'acquisition'])) {
    return { role: 'PROSPECTING', evidence: ['acquisition/performance signal in objective'] };
  }
  return { role: 'UNKNOWN', evidence: ['no reliable deterministic role signal'] };
}

export function evidenceConfidence(window: MetricWindow): EvidenceConfidence {
  const expectedCoverage = Math.min(window.days, 7);
  if (window.observedDays < Math.min(3, expectedCoverage) || window.impressions < 1_000) {
    return 'INSUFFICIENT';
  }
  if (window.conversions < 5) return 'LOW';
  if (
    window.observedDays < Math.min(6, expectedCoverage) ||
    window.conversions < 15 ||
    window.impressions < 5_000
  ) {
    return 'MODERATE';
  }
  return 'HIGH';
}

export function inventoryRisk(available: number, dailyVelocity: number): {
  risk: InventoryRisk;
  runwayDays: number | null;
} {
  if (available <= 0) return { risk: 'CRITICAL', runwayDays: 0 };
  if (dailyVelocity <= 0) return { risk: 'UNKNOWN', runwayDays: null };

  const runwayDays = available / dailyVelocity;
  if (runwayDays <= 7) return { risk: 'CRITICAL', runwayDays: round(runwayDays, 1) };
  if (runwayDays <= 14) return { risk: 'LOW', runwayDays: round(runwayDays, 1) };
  return { risk: 'HEALTHY', runwayDays: round(runwayDays, 1) };
}

export function creativeFatigue(
  recent: MetricWindow,
  previous: MetricWindow,
): { level: CreativeFatigue; evidence: string[] } {
  if (recent.impressions < 1_000 || previous.impressions < 1_000) {
    return { level: 'INSUFFICIENT', evidence: ['not enough impressions across both periods'] };
  }

  const ctrDrop =
    recent.ctr !== null && previous.ctr !== null && previous.ctr > 0
      ? (previous.ctr - recent.ctr) / previous.ctr
      : 0;
  const cpaIncrease =
    recent.cpa !== null && previous.cpa !== null && previous.cpa > 0
      ? (recent.cpa - previous.cpa) / previous.cpa
      : 0;
  const evidence: string[] = [];

  if (ctrDrop >= 0.2) evidence.push(`CTR fell ${Math.round(ctrDrop * 100)}%`);
  if (cpaIncrease >= 0.2) evidence.push(`CPA rose ${Math.round(cpaIncrease * 100)}%`);
  if ((recent.frequency ?? 0) >= 2.5) evidence.push(`frequency is ${recent.frequency}`);

  if (ctrDrop >= 0.25 && cpaIncrease >= 0.2 && (recent.frequency ?? 0) >= 2.5) {
    return { level: 'HIGH', evidence };
  }
  if (ctrDrop >= 0.2 || cpaIncrease >= 0.25) {
    return { level: 'MODERATE', evidence };
  }
  return { level: 'LOW', evidence: evidence.length ? evidence : ['no material fatigue signal'] };
}

export function previousSevenDayWindow(
  rows: NormalizedDailyMetrics[],
  now = new Date(),
): MetricWindow {
  const shifted = new Date(now);
  shifted.setUTCDate(shifted.getUTCDate() - 7);
  return aggregateMetricWindow(rows, 7, shifted);
}

function financialBlockers(
  confidence: EvidenceConfidence,
  context: FinancialDecisionContext,
): string[] {
  const blockers: string[] = [];

  if (confidence !== 'HIGH') blockers.push('financial recommendation requires HIGH evidence confidence');
  if (context.mappingConfidence === null || context.mappingConfidence < 0.9) {
    blockers.push('product mapping confidence is below 0.90 or unavailable');
  }
  if (context.breakEvenRoas === null || context.breakEvenRoas <= 0) {
    blockers.push('break-even ROAS is unavailable');
  }
  if (
    context.contributionMarginRatio === null ||
    context.contributionMarginRatio <= 0 ||
    context.contributionMarginRatio > 1
  ) {
    blockers.push('reliable contribution margin is unavailable');
  }
  if (context.inventoryRisk === 'UNKNOWN') blockers.push('inventory runway is unknown');
  if (context.commerceTrend === 'UNKNOWN') blockers.push('Shopify demand trend is unavailable');
  if (context.dataFreshnessHours === null || context.dataFreshnessHours > 36) {
    blockers.push('provider or commerce data is stale');
  }
  if (
    context.hoursSinceMaterialCampaignChange === null ||
    context.hoursSinceMaterialCampaignChange < 48
  ) {
    blockers.push('campaign has not had a stable 48-hour observation period');
  }

  return blockers;
}

export function candidateDecision(input: {
  recent: MetricWindow;
  previous: MetricWindow;
  confidence: EvidenceConfidence;
  fatigue: CreativeFatigue;
  context: FinancialDecisionContext;
}): CandidateDecision {
  if (input.context.mappingConfidence !== null && input.context.mappingConfidence < 0.7) {
    return {
      action: 'REVIEW_MAPPING',
      confidence: input.confidence,
      reasons: ['mapping is too uncertain to connect ad performance to commerce outcomes'],
      blockers: [],
      financialAction: false,
    };
  }

  if (input.confidence === 'INSUFFICIENT' || input.confidence === 'LOW') {
    return {
      action: 'COLLECT_MORE_DATA',
      confidence: input.confidence,
      reasons: ['there is not enough evidence for a money-impacting recommendation'],
      blockers: [],
      financialAction: false,
    };
  }

  if (input.fatigue === 'HIGH') {
    return {
      action: 'REPLACE_CREATIVE',
      confidence: input.confidence,
      reasons: ['relative CTR/CPA/frequency evidence indicates material creative fatigue'],
      blockers: [],
      financialAction: false,
    };
  }

  const blockers = financialBlockers(input.confidence, input.context);
  if (blockers.length > 0) {
    return {
      action: 'NO_RECOMMENDATION',
      confidence: input.confidence,
      reasons: ['the system abstained because a financially material input is missing or unstable'],
      blockers,
      financialAction: false,
    };
  }

  if (input.context.inventoryRisk === 'CRITICAL') {
    return {
      action: 'REDUCE',
      confidence: input.confidence,
      reasons: ['inventory runway is critical; additional paid demand risks stockout'],
      blockers: [],
      financialAction: true,
    };
  }

  const breakEvenRoas = input.context.breakEvenRoas!;
  const recentRoas = input.recent.roas;
  const previousRoas = input.previous.roas;
  if (recentRoas === null || previousRoas === null) {
    return {
      action: 'NO_RECOMMENDATION',
      confidence: input.confidence,
      reasons: ['ROAS cannot be evaluated consistently across both observation windows'],
      blockers: ['recent or previous attributed conversion value is unavailable'],
      financialAction: false,
    };
  }

  const profitableNow = recentRoas >= breakEvenRoas * 1.25;
  const profitableBefore = previousRoas >= breakEvenRoas * 1.1;
  if (
    profitableNow &&
    profitableBefore &&
    input.context.inventoryRisk === 'HEALTHY' &&
    input.context.commerceTrend !== 'DOWN'
  ) {
    return {
      action: 'SCALE',
      confidence: input.confidence,
      reasons: [
        'ROAS remains materially above break-even across independent windows',
        'inventory is healthy and Shopify demand does not contradict the ad-platform signal',
      ],
      blockers: [],
      financialAction: true,
    };
  }

  const unprofitableNow = recentRoas <= breakEvenRoas * 0.8;
  const unprofitableBefore = previousRoas <= breakEvenRoas * 0.9;
  if (unprofitableNow && unprofitableBefore) {
    return {
      action: 'REDUCE',
      confidence: input.confidence,
      reasons: ['ROAS remains materially below break-even across both observation windows'],
      blockers: [],
      financialAction: true,
    };
  }

  return {
    action: 'HOLD',
    confidence: input.confidence,
    reasons: ['evidence is financially complete but does not support a directional change'],
    blockers: [],
    financialAction: false,
  };
}
