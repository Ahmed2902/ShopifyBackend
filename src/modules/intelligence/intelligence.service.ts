import { AppError } from '../../errors/app-error.js';
import { IntelligenceRepository } from './intelligence.repository.js';
import type { IntelligenceDecision, ProductSignal, ProviderSignal } from './intelligence.types.js';
import type { IntelligenceQuery } from './intelligence.schema.js';

const DAY_MS = 24 * 60 * 60 * 1000;

function round(value: number, digits = 2) {
  const multiplier = 10 ** digits;
  return Math.round(value * multiplier) / multiplier;
}

function paidTotals(providers: ProviderSignal[]) {
  const totals = providers.reduce(
    (result, provider) => ({
      impressions: result.impressions + provider.impressions,
      clicks: result.clicks + provider.clicks,
      conversions: result.conversions + provider.conversions,
      ads: result.ads + provider.ads,
      activeAds: result.activeAds + provider.activeAds,
    }),
    { impressions: 0, clicks: 0, conversions: 0, ads: 0, activeAds: 0 },
  );
  const spending = providers.filter((provider) => provider.spend > 0);
  const currencies = [...new Set(spending.map((provider) => provider.currency).filter((currency): currency is string => Boolean(currency)))];
  const hasUnknownCurrencySpend = spending.some((provider) => !provider.currency);
  const monetaryComparable = !hasUnknownCurrencySpend && currencies.length <= 1;
  const spend = monetaryComparable ? spending.reduce((sum, provider) => sum + provider.spend, 0) : null;
  const conversionValue = monetaryComparable ? spending.reduce((sum, provider) => sum + provider.conversionValue, 0) : null;
  return {
    ...totals,
    hasSpend: spending.length > 0,
    monetaryComparable,
    currency: monetaryComparable ? currencies[0] ?? null : null,
    spend,
    conversionValue,
    roas: spend !== null && spend > 0 && conversionValue !== null && conversionValue > 0 ? conversionValue / spend : null,
  };
}

function decisionPriority(decision: IntelligenceDecision, confidence: number, spend: number) {
  const weight: Record<IntelligenceDecision, number> = {
    PAUSE: 100,
    REDUCE: 85,
    SCALE: 75,
    TEST: 60,
    HOLD: 45,
    MORE_DATA: 30,
  };
  return weight[decision] + Math.min(15, confidence * 10) + Math.min(10, Math.log10(Math.max(1, spend)) * 2);
}

function buildRecommendation(product: ProductSignal, lookbackDays: number, now: Date) {
  const paid = paidTotals(product.providers);
  const dailyUnits = product.unitsSold / lookbackDays;
  const runwayDays = product.tracksInventory && dailyUnits > 0 ? product.available / dailyUnits : null;
  const restockDays = product.nextRestockAt
    ? Math.max(0, (product.nextRestockAt.getTime() - now.getTime()) / DAY_MS)
    : null;
  const mappingConfidence = product.mappingConfidence ?? 0;
  const reasons: string[] = [];
  let decision: IntelligenceDecision = 'HOLD';

  if (product.sharedAdMapping) {
    decision = 'MORE_DATA';
    reasons.push('At least one paid ad is mapped to multiple products, so product-level spend attribution is not precise enough yet.');
  } else if (mappingConfidence < 0.6 && !product.mappingConfirmed) {
    decision = 'MORE_DATA';
    reasons.push('The paid-to-product mapping confidence is below the decision threshold.');
  } else if (!paid.hasSpend || paid.impressions < 500) {
    decision = 'MORE_DATA';
    reasons.push('There is not enough recent paid-delivery evidence to make a budget recommendation.');
  } else if (product.tracksInventory && product.available <= 0) {
    decision = 'PAUSE';
    reasons.push('The mapped product is out of available tracked inventory while paid demand is still active.');
  } else if (runwayDays !== null && runwayDays < 1.5) {
    decision = 'PAUSE';
    reasons.push(`Current sell-through leaves only ${round(runwayDays, 1)} days of stock runway.`);
  } else if (runwayDays !== null && runwayDays < 7) {
    decision = 'REDUCE';
    reasons.push(`Current sell-through leaves about ${round(runwayDays, 1)} days of stock runway.`);
  } else if (runwayDays !== null && restockDays !== null && runwayDays + 1 < restockDays) {
    decision = 'REDUCE';
    reasons.push(`Projected stock runway ends before the next recorded restock in ${round(restockDays, 1)} days.`);
  } else if (!paid.monetaryComparable) {
    decision = 'HOLD';
    reasons.push('Mapped paid sources use different or unknown currencies, so Stride keeps monetary performance separate instead of inventing a combined spend or ROAS figure.');
  } else if (paid.conversions < 2 && paid.hasSpend) {
    decision = 'TEST';
    reasons.push('Paid delivery exists, but conversion evidence is still too thin for a scale or cut decision.');
  } else if (paid.roas !== null && paid.roas >= 2 && (runwayDays === null || runwayDays >= 21)) {
    decision = 'SCALE';
    reasons.push(`Recent mapped paid demand is returning about ${round(paid.roas)}× while inventory has room to absorb more demand.`);
  } else if (paid.roas !== null && paid.roas < 0.8 && paid.conversions >= 3) {
    decision = 'REDUCE';
    reasons.push(`Recent mapped paid demand is returning about ${round(paid.roas)}× across enough conversions to justify reducing pressure.`);
  } else {
    decision = 'HOLD';
    reasons.push('Paid demand and inventory are inside the current safety range; there is no strong reason to force a change.');
  }

  if (product.mappingConfirmed) reasons.push('At least one product mapping was merchant-confirmed.');
  if (product.incoming > 0) reasons.push(`${product.incoming} incoming units are already visible in Shopify inventory.`);

  const dataScore = Math.min(1, paid.impressions / 5000) * 0.35 + Math.min(1, paid.conversions / 10) * 0.25;
  const mappingScore = Math.min(1, mappingConfidence) * 0.25;
  const commerceScore = Math.min(1, product.orderCount / 10) * 0.15;
  const confidence = round(Math.max(0.15, Math.min(0.99, dataScore + mappingScore + commerceScore)), 2);

  return {
    product: { id: product.productId, title: product.title, status: product.status },
    decision,
    confidence,
    priority: round(decisionPriority(decision, confidence, paid.spend ?? 0), 1),
    headline:
      decision === 'SCALE' ? 'There is room to put more demand here.'
        : decision === 'HOLD' ? 'Keep the current pressure steady.'
          : decision === 'REDUCE' ? 'Reduce pressure before the constraint gets worse.'
            : decision === 'PAUSE' ? 'Stop adding paid pressure until the constraint clears.'
              : decision === 'TEST' ? 'Keep the test small while signal develops.'
                : 'Get cleaner evidence before changing budget.',
    reasons,
    evidence: {
      inventory: {
        tracked: product.tracksInventory,
        available: product.available,
        incoming: product.incoming,
        runwayDays: runwayDays === null ? null : round(runwayDays, 1),
        nextRestockAt: product.nextRestockAt,
        restockDays: restockDays === null ? null : round(restockDays, 1),
      },
      commerce: {
        lookbackDays,
        unitsSold: product.unitsSold,
        orderCount: product.orderCount,
        averageUnitsPerDay: round(dailyUnits, 2),
      },
      mapping: {
        confidence: product.mappingConfidence === null ? null : round(product.mappingConfidence, 3),
        merchantConfirmed: product.mappingConfirmed,
        sharedAdMapping: product.sharedAdMapping,
      },
      paid: {
        currency: paid.currency,
        monetaryComparable: paid.monetaryComparable,
        spend: paid.spend === null ? null : round(paid.spend),
        impressions: Math.round(paid.impressions),
        clicks: Math.round(paid.clicks),
        conversions: round(paid.conversions, 1),
        conversionValue: paid.conversionValue === null ? null : round(paid.conversionValue),
        roas: paid.roas === null ? null : round(paid.roas),
        ads: paid.ads,
        activeAds: paid.activeAds,
        providers: product.providers.map((provider) => ({
          ...provider,
          spend: round(provider.spend),
          conversions: round(provider.conversions, 1),
          conversionValue: round(provider.conversionValue),
          roas: provider.roas === null ? null : round(provider.roas),
        })),
      },
    },
  };
}

export class IntelligenceService {
  constructor(private readonly repository: IntelligenceRepository) {}

  async getRecommendations(storeId: string, query: IntelligenceQuery) {
    const now = new Date();
    const from = new Date(now.getTime() - (query.lookbackDays - 1) * DAY_MS);
    from.setUTCHours(0, 0, 0, 0);
    const to = new Date(now);
    to.setUTCHours(23, 59, 59, 999);

    const dataset = await this.repository.load(storeId, from, to);
    if (!dataset) throw new AppError('Store not found', 404, 'STORE_NOT_FOUND');

    const recommendations = dataset.products
      .map((product) => buildRecommendation(product, query.lookbackDays, now))
      .sort((left, right) => right.priority - left.priority)
      .slice(0, query.limit);

    const counts = recommendations.reduce<Record<IntelligenceDecision, number>>(
      (result, item) => ({ ...result, [item.decision]: result[item.decision] + 1 }),
      { SCALE: 0, HOLD: 0, REDUCE: 0, PAUSE: 0, TEST: 0, MORE_DATA: 0 },
    );

    return {
      engine: { id: 'RULES_V1', label: 'Auditable decision engine', automaticMutations: false },
      generatedAt: now,
      window: { from, to, lookbackDays: query.lookbackDays },
      readiness: {
        connections: dataset.connections,
        joinedProducts: dataset.products.length,
        recommendations: recommendations.length,
      },
      counts,
      recommendations,
    };
  }
}

export const intelligenceService = new IntelligenceService(new IntelligenceRepository());
