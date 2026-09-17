import type { CreativeVideoRetention } from '../analytics/creative-video-retention.service.js';
import type { CreativeEvidence, RecommendationDraft } from './intelligence.types.js';

const RULE_VERSION = '1';
const INVALID_COMPARISON_CODES = new Set([
  'COMPARISON_INSUFFICIENT_PLAYS',
  'COMPARISON_INCONSISTENT_PROVIDER_DATA',
]);

function pointChange(current: number | null, comparison: number | null): number | null {
  if (current === null || comparison === null) return null;
  return current - comparison;
}

export function videoRetentionDeteriorationRule(
  creative: CreativeEvidence,
  retention: CreativeVideoRetention | null | undefined,
  window: { currentStart: Date; currentEnd: Date; comparisonStart: Date; comparisonEnd: Date },
): RecommendationDraft | null {
  if (!retention || retention.status !== 'READY' || retention.evidenceQuality === 'LOW') return null;
  const current = retention.current;
  const comparison = retention.comparison;
  if (!current || !comparison) return null;

  const comparisonInvalid =
    comparison.plays === null ||
    comparison.plays < retention.minimumDiagnosticPlays ||
    retention.limitations.some((limitation) => INVALID_COMPARISON_CODES.has(limitation.code));
  if (comparisonInvalid) return null;

  const hookPoints = pointChange(current.rates.to25, comparison.rates.to25);
  const completionPoints = pointChange(current.rates.completion, comparison.rates.completion);
  const hookWeak = hookPoints !== null && hookPoints <= -0.1;
  const completionWeak = completionPoints !== null && completionPoints <= -0.1;
  if (!hookWeak && !completionWeak) return null;

  const magnitude = Math.max(Math.abs(hookPoints ?? 0), Math.abs(completionPoints ?? 0));
  const confidenceScore = retention.evidenceQuality === 'HIGH' ? 0.9 : 0.78;

  return {
    ruleId: 'video_retention_deterioration',
    ruleVersion: RULE_VERSION,
    category: 'VIDEO_RETENTION',
    severity: magnitude >= 0.2 ? 'HIGH' : 'MEDIUM',
    entityType: 'CREATIVE',
    entityId: creative.entityId,
    externalEntityId: creative.externalEntityId,
    title: 'Video retention weakened versus its recent baseline',
    summary: 'Observed Meta video viewers are dropping earlier or completing the creative less often than in the comparison period.',
    suggestedAction: 'Test a replacement edit or opening sequence and compare retention before scaling the current creative.',
    impactScore: Math.max(0.2, Math.min(1, creative.spendShare)),
    confidenceScore,
    urgencyScore: Math.min(1, 0.55 + magnitude),
    evidenceQuality: retention.evidenceQuality,
    attributionPrecision: 'META_PROVIDER',
    limitations: retention.limitations,
    observationStart: window.currentStart,
    observationEnd: window.currentEnd,
    comparisonStart: window.comparisonStart,
    comparisonEnd: window.comparisonEnd,
    evidence: {
      source: 'META_VIDEO_INSIGHTS',
      current,
      comparison,
      hookRatePointChange: hookPoints,
      completionRatePointChange: completionPoints,
      largestCurrentDropStage: current.largestDropStage,
      interpretation: 'Observed retention deterioration, not semantic hook/body/CTA analysis.',
    },
  };
}
