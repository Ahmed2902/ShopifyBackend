import type {
  CampaignRole,
  CandidateDecision,
  CreativeFatigue,
  EvidenceConfidence,
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
  const weightedFrequencyDenominator = selected.reduce(
    (sum, row) => sum + (row.frequency !== null ? row.impressions : 0),
    0,
  );
  const frequency = weightedFrequencyDenominator
    ? selected.reduce(
        (sum, row) => sum + (row.frequency ?? 0) * row.impressions,
        0,
      ) / weightedFrequencyDenominator
    : null;

  return {
    days,
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
  const evidence: string[] = [];
  const has = (terms: string[]) => terms.some((term) => text.includes(term));

  if (has(['retarget', 'remarket', 'rtg', 're-engage', 'reengage'])) {
    evidence.push('name/objective contains retargeting signal');
    return { role: 'RETARGETING', evidence };
  }
  if (has(['retention', 'loyalty', 'existing customer', 'repeat customer', 'customer list'])) {
    evidence.push('name/objective contains retention signal');
    return { role: 'RETENTION', evidence };
  }
  if (input.catalogId || has(['catalog', 'product sales', 'product_sales', 'shopping'])) {
    evidence.push(input.catalogId ? 'catalog is attached' : 'objective contains catalog signal');
    return { role: 'CATALOG', evidence };
  }
  if (has(['launch', 'new product', 'new collection'])) {
    evidence.push('name contains product-launch signal');
    return { role: 'PRODUCT_LAUNCH', evidence };
  }
  if (has(['awareness', 'brand awareness', 'reach', 'video views'])) {
    evidence.push('objective contains brand/reach signal');
    return { role: 'BRAND', evidence };
  }
  if (has(['sales', 'conversion', 'purchase', 'traffic', 'prospecting', 'acquisition'])) {
    evidence.push('objective contains acquisition/performance signal');
    return { role: 'PROSPECTING', evidence };
  }
  return { role: 'UNKNOWN', evidence: ['no reliable deterministic role signal'] };
}

export function evidenceConfidence(window: MetricWindow): EvidenceConfidence {
  if (window.spend <= 0 || window.impressions < 1_000) return 'INSUFFICIENT';
  if (window.conversions < 3) return 'LOW';
  if (window.conversions < 10 || window.impressions < 10_000) return 'MODERATE';
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
    recent.ctr !== null && previous.ctr && previous.ctr > 0
      ? (previous.ctr - recent.ctr) / previous.ctr
      : 0;
  const cpaIncrease =
    recent.cpa !== null && previous.cpa && previous.cpa > 0
      ? (recent.cpa - previous.cpa) / previous.cpa
      : 0;
  const evidence: string[] = [];
  if (ctrDrop >= 0.2) evidence.push(`CTR fell ${Math.round(ctrDrop * 100)}%`);
  if (cpaIncrease >= 0.2) evidence.push(`CPA rose ${Math.round(cpaIncrease * 100)}%`);
  if ((recent.frequency ?? 0) >= 2.5) evidence.push(`frequency is ${recent.frequency}`);

  if (ctrDrop >= 0.25 && cpaIncrease >= 0.2 && (recent.frequency ?? 0) >= 2.5) {
    return { level: 'HIGH', evidence };
  }
  if (ctrDrop >= 0.2 || (recent.frequency ?? 0) >= 3.5) {
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

export function candidateDecision(input: {
  metrics: MetricWindow;
  previous: MetricWindow;
  confidence: EvidenceConfidence;
  fatigue: CreativeFatigue;
  mappingConfidence: number | null;
  inventoryRisk: InventoryRisk;
}): CandidateDecision {
  const reasons: string[] = [];
  const base = {
    confidence: input.confidence,
    guardrails: {
      automaticExecutionAllowed: false as const,
      maxSuggestedBudgetChangePercent: null as number | null,
    },
  };

  if (input.mappingConfidence !== null && input.mappingConfidence < 0.7) {
    return {
      action: 'REVIEW_MAPPING',
      ...base,
      reasons: ['product mapping confidence is below 0.70'],
    };
  }

  if (input.confidence === 'INSUFFICIENT') {
    return {
      action: 'COLLECT_MORE_DATA',
      ...base,
      reasons: ['insufficient impressions/spend for a decision'],
    };
  }

  if (input.inventoryRisk === 'CRITICAL') {
    reasons.push('mapped product inventory runway is critical');
    if ((input.metrics.roas ?? 0) >= 1.5) reasons.push('performance is useful but stock constrains scale');
    return { action: 'REDUCE', ...base, reasons };
  }

  if (input.fatigue === 'HIGH') {
    return {
      action: 'REPLACE_CREATIVE',
      ...base,
      reasons: ['high deterministic creative-fatigue signal'],
    };
  }

  const ctr = input.metrics.ctr ?? 0;
  const cvr = input.metrics.cvr ?? 0;
  if (input.metrics.spend >= 25 && ctr >= 1.5 && cvr < 0.5) {
    return {
      action: 'REVIEW_LANDING_PAGE',
      ...base,
      reasons: ['click-through is healthy while post-click conversion is weak'],
    };
  }

  if (input.metrics.spend >= 25 && ctr < 0.7) {
    return {
      action: 'REPLACE_CREATIVE',
      ...base,
      reasons: ['low CTR after meaningful spend'],
    };
  }

  const priorRoas = input.previous.roas ?? 0;
  if (
    (input.confidence === 'HIGH' || input.confidence === 'MODERATE') &&
    input.inventoryRisk !== 'LOW' &&
    (input.metrics.roas ?? 0) >= 2 &&
    input.metrics.conversions >= 10 &&
    (priorRoas === 0 || (input.metrics.roas ?? 0) >= priorRoas * 0.85)
  ) {
    return {
      action: 'SCALE',
      ...base,
      reasons: ['ROAS and conversion evidence are strong enough for a guarded scale candidate'],
      guardrails: { automaticExecutionAllowed: false, maxSuggestedBudgetChangePercent: 15 },
    };
  }

  if (input.metrics.spend >= 50 && (input.metrics.roas ?? 0) < 1 && input.metrics.conversions >= 3) {
    return {
      action: 'PAUSE',
      ...base,
      reasons: ['sustained spend with sub-1 attributed ROAS'],
    };
  }

  return {
    action: 'HOLD',
    ...base,
    reasons: ['no deterministic rule justifies a stronger action'],
  };
}
