import type { RecommendationDraft } from './intelligence.types.js';

interface VideoRetention {
  status: 'READY' | 'INSUFFICIENT_PLAYS' | 'NO_VIDEO_DATA' | 'NOT_VIDEO' | 'INCONSISTENT_PROVIDER_DATA';
  evidenceQuality: 'LOW' | 'MEDIUM' | 'HIGH';
  current: {
    plays: number | null;
    rates: { to25: number | null; completion: number | null };
    largestDropStage: string | null;
    largestDropRate: number | null;
  } | null;
  comparison: {
    plays: number | null;
    rates: { to25: number | null; completion: number | null };
  } | null;
  change: {
    to25RatePoints: number | null;
    completionRatePoints: number | null;
    averageTimeWatchedSeconds: number | null;
  };
  limitations: Array<{ code: string; message: string }>;
}

export function videoRetentionDeteriorationRule(input: {
  entityId: string;
  externalEntityId: string;
  name: string;
  retention: VideoRetention;
  observationStart: Date;
  observationEnd: Date;
  comparisonStart: Date;
  comparisonEnd: Date;
}): RecommendationDraft | null {
  const retention = input.retention;
  if (retention.status !== 'READY' || !retention.current || !retention.comparison) return null;
  const earlyDrop = retention.change.to25RatePoints;
  const completionDrop = retention.change.completionRatePoints;
  const deteriorated =
    (earlyDrop !== null && earlyDrop <= -0.12) ||
    (completionDrop !== null && completionDrop <= -0.1);
  if (!deteriorated) return null;

  const magnitude = Math.max(Math.abs(earlyDrop ?? 0), Math.abs(completionDrop ?? 0));
  return {
    ruleId: 'video_retention_deterioration',
    ruleVersion: '1',
    category: 'VIDEO_RETENTION',
    severity: magnitude >= 0.2 ? 'HIGH' : 'MEDIUM',
    entityType: 'CREATIVE',
    entityId: input.entityId,
    externalEntityId: input.externalEntityId,
    title: 'Video retention weakened versus the comparison period',
    summary: 'Meta video retention deteriorated at the opening or completion stage with enough play evidence for a descriptive diagnosis.',
    suggestedAction: 'Test a replacement or revised video creative and compare its retention before increasing spend.',
    impactScore: Math.min(1, (retention.current.plays ?? 0) / 5_000),
    confidenceScore: retention.evidenceQuality === 'HIGH' ? 0.9 : retention.evidenceQuality === 'MEDIUM' ? 0.76 : 0.58,
    urgencyScore: Math.min(1, 0.5 + magnitude * 2),
    evidenceQuality: retention.evidenceQuality,
    attributionPrecision: 'META_PROVIDER',
    limitations: retention.limitations,
    observationStart: input.observationStart,
    observationEnd: input.observationEnd,
    comparisonStart: input.comparisonStart,
    comparisonEnd: input.comparisonEnd,
    evidence: {
      source: 'META_VIDEO_INSIGHTS',
      creativeName: input.name,
      current: retention.current,
      comparison: retention.comparison,
      change: retention.change,
      interpretation: 'OBSERVATIONAL_RETENTION_NOT_SEMANTIC_HOOK_ANALYSIS',
    },
  };
}
