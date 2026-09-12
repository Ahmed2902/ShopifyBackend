import type {
  RecommendationDecisionMetadata,
  RecommendationDraft,
} from './intelligence.types.js';

export function recommendationDecision(
  recommendation: RecommendationDraft,
): RecommendationDecisionMetadata {
  let decisionAction: RecommendationDecisionMetadata['decisionAction'];
  let decisionMessage = recommendation.suggestedAction;

  switch (recommendation.ruleId) {
    case 'campaign_efficiency_deterioration':
      decisionAction = recommendation.severity === 'HIGH' ? 'REDUCE' : 'HOLD';
      decisionMessage =
        recommendation.severity === 'HIGH'
          ? 'Reduce or cap further spend while you investigate the efficiency deterioration.'
          : 'Hold the current budget and investigate the efficiency deterioration before scaling further.';
      break;
    case 'creative_fatigue_symptoms':
      decisionAction = 'TEST';
      decisionMessage =
        'Prepare and test a replacement creative before the current fatigue symptoms worsen.';
      break;
    case 'underexposed_commerce_winner':
      decisionAction = 'TEST';
      decisionMessage =
        'Run a controlled paid-traffic test; do not treat this signal as an automatic budget increase.';
      break;
    case 'paid_commerce_exposure_mismatch':
      decisionAction = 'INVESTIGATE';
      decisionMessage =
        'Investigate traffic fit, product offer and landing experience before increasing exposure.';
      break;
    case 'provider_roas_margin_trap':
      decisionAction = 'REDUCE';
      decisionMessage =
        'Reduce further scaling pressure and review product economics before trusting provider ROAS as a growth signal.';
      break;
    case 'inventory_spend_conflict':
    case 'shared_exposure_inventory_conflict':
      decisionAction = 'HOLD';
      decisionMessage =
        'Hold aggressive paid scaling until replenishment or inventory protection is confirmed.';
      break;
    default:
      decisionAction = 'INVESTIGATE';
      break;
  }

  return {
    decisionAction,
    decisionConfidence: recommendation.evidenceQuality,
    decisionBasis: 'DETERMINISTIC_RULE',
    decisionMessage,
  };
}
