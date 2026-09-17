import type { RecommendationDraft } from './intelligence.types.js';

export function mappingCoverageDegradedRule(input: {
  mappingCoverage: number;
  metaRows: number;
  observationStart: Date;
  observationEnd: Date;
}): RecommendationDraft | null {
  if (input.metaRows <= 0 || input.mappingCoverage >= 0.6) return null;
  const veryLow = input.mappingCoverage < 0.3;
  const confidenceScore = veryLow ? 0.88 : 0.8;
  return {
    ruleId: 'mapping_coverage_degraded',
    ruleVersion: '1',
    category: 'MAPPING_HEALTH',
    severity: veryLow ? 'HIGH' : 'MEDIUM',
    entityType: 'STORE',
    entityId: null,
    externalEntityId: null,
    title: 'A meaningful share of paid exposure is not mapped confidently',
    summary: veryLow
      ? 'Less than 30% of eligible Meta evidence is covered by high-confidence product mappings, limiting product-level paid intelligence.'
      : 'Less than 60% of eligible Meta evidence is covered by high-confidence product mappings, so product-level comparisons are incomplete.',
    suggestedAction: 'Review unresolved high-spend ads and confirm their promoted product or collection scope.',
    impactScore: 1 - input.mappingCoverage,
    confidenceScore,
    urgencyScore: veryLow ? 0.78 : 0.58,
    evidenceQuality: confidenceScore >= 0.82 ? 'HIGH' : 'MEDIUM',
    attributionPrecision: 'STORE',
    limitations: [],
    observationStart: input.observationStart,
    observationEnd: input.observationEnd,
    comparisonStart: null,
    comparisonEnd: null,
    evidence: {
      source: 'STRIDE_MAPPING_EVIDENCE',
      mappingCoverage: input.mappingCoverage,
      metaRows: input.metaRows,
    },
  };
}
