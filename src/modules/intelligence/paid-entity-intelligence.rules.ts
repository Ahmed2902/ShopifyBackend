import type { RecommendationDraft, RecommendationEntityType } from './intelligence.types.js';

interface PaidMetrics {
  spend: number;
  impressions: number;
  clicks: number;
  purchases: number;
  purchaseValue: number;
  providerRoas: number | null;
  cpa: number | null;
  ctr: number | null;
  cpc: number | null;
  cpm: number | null;
  averageDailyFrequency: number | null;
}

function change(current: number | null, comparison: number | null): number | null {
  if (current === null || comparison === null || comparison === 0) return null;
  return (current - comparison) / Math.abs(comparison);
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

export function paidEntityEfficiencyRule(input: {
  entityType: Extract<RecommendationEntityType, 'AD_SET' | 'AD'>;
  entityId: string;
  externalEntityId: string;
  name: string;
  currency: string | null;
  current: PaidMetrics;
  comparison: PaidMetrics;
  observationStart: Date;
  observationEnd: Date;
  comparisonStart: Date;
  comparisonEnd: Date;
}): RecommendationDraft | null {
  if (
    input.current.impressions < 1_000 ||
    input.comparison.impressions < 1_000 ||
    input.current.spend <= 0 ||
    input.comparison.spend <= 0
  ) return null;

  const spendChange = change(input.current.spend, input.comparison.spend);
  const roasChange = change(input.current.providerRoas, input.comparison.providerRoas);
  const cpaChange = change(input.current.cpa, input.comparison.cpa);
  const ctrChange = change(input.current.ctr, input.comparison.ctr);
  const cpmChange = change(input.current.cpm, input.comparison.cpm);
  const spendExpanded = spendChange !== null && spendChange >= 0.15;
  const efficiencyWeak =
    (roasChange !== null && roasChange <= -0.2) ||
    (cpaChange !== null && cpaChange >= 0.2);
  if (!spendExpanded || !efficiencyWeak) return null;

  const magnitude = Math.max(Math.abs(roasChange ?? 0), Math.max(cpaChange ?? 0, 0));
  const support = clamp01(
    Math.min(input.current.impressions, input.comparison.impressions) / 10_000,
  );
  const confidenceScore = clamp01(0.58 + support * 0.28);
  const noun = input.entityType === 'AD_SET' ? 'Ad set' : 'Ad';

  return {
    ruleId:
      input.entityType === 'AD_SET'
        ? 'adset_efficiency_deterioration'
        : 'ad_efficiency_deterioration',
    ruleVersion: '1',
    category: 'PAID_EFFICIENCY',
    severity: magnitude >= 0.35 ? 'HIGH' : 'MEDIUM',
    entityType: input.entityType,
    entityId: input.entityId,
    externalEntityId: input.externalEntityId,
    title: `${noun} efficiency weakened while spend increased`,
    summary: `${noun} spend increased while provider-reported conversion efficiency weakened versus the comparison period.`,
    suggestedAction: `Review this ${noun.toLowerCase()}'s delivery and downstream fit before increasing spend further.`,
    impactScore: clamp01(input.current.spend / Math.max(input.current.spend + input.comparison.spend, 1)),
    confidenceScore,
    urgencyScore: clamp01(0.55 + magnitude * 0.45),
    evidenceQuality: confidenceScore >= 0.82 ? 'HIGH' : confidenceScore >= 0.58 ? 'MEDIUM' : 'LOW',
    attributionPrecision: 'META_PROVIDER',
    limitations: [],
    observationStart: input.observationStart,
    observationEnd: input.observationEnd,
    comparisonStart: input.comparisonStart,
    comparisonEnd: input.comparisonEnd,
    evidence: {
      source: 'META_PROVIDER_ATTRIBUTION',
      currency: input.currency,
      entityName: input.name,
      current: input.current,
      comparison: input.comparison,
      changes: { spend: spendChange, roas: roasChange, cpa: cpaChange, ctr: ctrChange, cpm: cpmChange },
    },
  };
}
