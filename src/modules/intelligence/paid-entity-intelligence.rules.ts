import type { PaidEntityEvidence } from './paid-entity-intelligence.metrics.js';
import type { RecommendationDraft } from './intelligence.types.js';

const RULE_VERSION = '1';
const MIN_IMPRESSIONS = 1_000;

function change(current: number | null, comparison: number | null): number | null {
  if (current === null || comparison === null || comparison === 0) return null;
  return (current - comparison) / Math.abs(comparison);
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

export function adEfficiencyDeteriorationRule(
  evidence: PaidEntityEvidence,
  window: { currentStart: Date; currentEnd: Date; comparisonStart: Date; comparisonEnd: Date },
): RecommendationDraft | null {
  if (
    evidence.current.impressions < MIN_IMPRESSIONS ||
    evidence.comparison.impressions < MIN_IMPRESSIONS ||
    evidence.current.spend <= 0 ||
    evidence.comparison.spend <= 0
  ) {
    return null;
  }

  const spendChange = change(evidence.current.spend, evidence.comparison.spend);
  const roasChange = change(evidence.current.roas, evidence.comparison.roas);
  const cpaChange = change(evidence.current.cpa, evidence.comparison.cpa);
  const ctrChange = change(evidence.current.ctr, evidence.comparison.ctr);
  const spendExpanded = spendChange !== null && spendChange >= 0.15;
  const efficiencyWeak =
    (roasChange !== null && roasChange <= -0.25) ||
    (cpaChange !== null && cpaChange >= 0.25);
  if (!spendExpanded || !efficiencyWeak) return null;

  const magnitude = Math.max(Math.abs(roasChange ?? 0), Math.max(cpaChange ?? 0, 0));
  const support = clamp01(
    Math.min(evidence.current.impressions, evidence.comparison.impressions) / 10_000,
  );

  return {
    ruleId: 'ad_efficiency_deterioration',
    ruleVersion: RULE_VERSION,
    category: 'AD_EFFICIENCY',
    severity: magnitude >= 0.4 ? 'HIGH' : 'MEDIUM',
    entityType: 'AD',
    entityId: evidence.entityId,
    externalEntityId: evidence.externalEntityId,
    title: 'Ad efficiency weakened while spend increased',
    summary: 'This ad received more spend while provider-reported ROAS or CPA materially weakened versus the comparison period.',
    suggestedAction: 'Hold further scaling and inspect the ad, creative and audience context before increasing spend.',
    impactScore: clamp01(Math.max(evidence.spendShare, 0.1)),
    confidenceScore: clamp01(0.62 + support * 0.25 + (ctrChange !== null ? 0.08 : 0)),
    urgencyScore: clamp01(0.55 + magnitude * 0.45),
    evidenceQuality: support >= 0.5 ? 'HIGH' : 'MEDIUM',
    attributionPrecision: 'META_PROVIDER',
    limitations: [],
    observationStart: window.currentStart,
    observationEnd: window.currentEnd,
    comparisonStart: window.comparisonStart,
    comparisonEnd: window.comparisonEnd,
    evidence: {
      source: 'META_PROVIDER_ATTRIBUTION',
      currency: evidence.currency,
      spendShare: evidence.spendShare,
      current: evidence.current,
      comparison: evidence.comparison,
      changes: {
        spend: spendChange,
        roas: roasChange,
        cpa: cpaChange,
        ctr: ctrChange,
      },
    },
  };
}
