export type KnowledgeDomain =
  | 'BUSINESS'
  | 'COMMERCE'
  | 'PRODUCTS'
  | 'COLLECTIONS'
  | 'CUSTOMERS'
  | 'INVENTORY'
  | 'PAID_MEDIA'
  | 'CREATIVES'
  | 'STOREFRONT'
  | 'ATTRIBUTION'
  | 'PRODUCT_ADS'
  | 'RECOMMENDATIONS'
  | 'DATA_QUALITY'
  | 'HISTORY';

export interface KnowledgeCapability {
  domain: KnowledgeDomain;
  description: string;
  sourceOfTruth: string[];
  entityTypes: string[];
  questions: string[];
  caveats: string[];
}

/**
 * Stable, model-readable map of what Stride knows.
 *
 * This catalog is intentionally independent from MCP. The UI, exports and future agents can use the
 * same vocabulary, while protocol adapters only decide how to expose it.
 */
export const BUSINESS_KNOWLEDGE_CATALOG: readonly KnowledgeCapability[] = [
  {
    domain: 'BUSINESS',
    description: 'Store identity, currency, timezone, domains, integration readiness and freshness.',
    sourceOfTruth: ['Stride store configuration', 'provider connection state'],
    entityTypes: ['STORE', 'INTEGRATION'],
    questions: ['What business am I looking at?', 'Which data sources are connected?', 'How fresh is the data?'],
    caveats: ['Connection state is not proof that every historical window has complete coverage.'],
  },
  {
    domain: 'COMMERCE',
    description: 'Shopify order value, refunds, discounts, customer mix, product economics and contribution before/after ads.',
    sourceOfTruth: ['Shopify orders', 'Shopify refunds', 'Shopify product costs'],
    entityTypes: ['STORE', 'ORDER', 'PRODUCT', 'VARIANT'],
    questions: ['How is revenue changing?', 'Are refunds or discounts hurting economics?', 'Is contribution after ads improving?'],
    caveats: ['Contribution after ads is not net profit.', 'Order-history coverage depends on Shopify authorization and completed syncs.'],
  },
  {
    domain: 'PRODUCTS',
    description: 'Product-level revenue, units, contribution, inventory context and period-over-period movement.',
    sourceOfTruth: ['Shopify catalog', 'Shopify orders', 'Shopify refunds', 'Shopify inventory'],
    entityTypes: ['PRODUCT', 'VARIANT'],
    questions: ['Which products drive growth?', 'Which products are declining?', 'Which products have supply pressure?'],
    caveats: ['Product economics follow order cohorts and linked refunds rather than provider attribution.'],
  },
  {
    domain: 'COLLECTIONS',
    description: 'Shopify collection membership and collection-level commerce performance.',
    sourceOfTruth: ['Shopify collections', 'Shopify orders'],
    entityTypes: ['COLLECTION', 'PRODUCT'],
    questions: ['Which collections are performing?', 'What products belong to a collection?'],
    caveats: ['Collection membership is the current Shopify membership when evaluating historical performance.'],
  },
  {
    domain: 'CUSTOMERS',
    description: 'Aggregate new/returning customer behavior and customer coverage without exposing unnecessary customer PII.',
    sourceOfTruth: ['Shopify customer/order linkage'],
    entityTypes: ['STORE'],
    questions: ['Are orders coming from new or returning customers?', 'How complete is customer classification?'],
    caveats: ['Advisor-facing knowledge is aggregate by default; raw customer PII is deliberately excluded.'],
  },
  {
    domain: 'INVENTORY',
    description: 'Current stock, selling velocity, days of cover and trusted inventory-aware risk.',
    sourceOfTruth: ['Shopify inventory', 'Shopify orders', 'Stride inventory planning'],
    entityTypes: ['PRODUCT', 'VARIANT'],
    questions: ['What may stock out?', 'Where is ad pressure colliding with low inventory?', 'What is overstocked?'],
    caveats: ['Deterministic inventory actions require TRUSTED inventory intelligence.'],
  },
  {
    domain: 'PAID_MEDIA',
    description: 'Provider-reported campaigns, ad sets, ads, spend, delivery, conversions, value and efficiency.',
    sourceOfTruth: ['Meta provider reporting', 'TikTok provider reporting'],
    entityTypes: ['AD_ACCOUNT', 'CAMPAIGN', 'AD_SET', 'AD'],
    questions: ['What is spending?', 'Which campaigns are efficient?', 'What changed in paid media?'],
    caveats: ['Provider attribution is not Shopify purchase truth.', 'Currencies are never silently combined.'],
  },
  {
    domain: 'CREATIVES',
    description: 'Creative-level delivery, efficiency, fatigue and video-retention evidence.',
    sourceOfTruth: ['Meta creative/insight data', 'TikTok creative/insight data'],
    entityTypes: ['CREATIVE', 'AD'],
    questions: ['Which creatives are tiring?', 'Which creative wins?', 'Where does video attention drop?'],
    caveats: ['Creative conclusions depend on sufficient delivery and the provider metrics available for that format.'],
  },
  {
    domain: 'STOREFRONT',
    description: 'First-party Stride Pixel sessions, product/cart/checkout funnel, landing pages and observed abandonment.',
    sourceOfTruth: ['Stride Pixel observed events', 'linked valid Shopify purchases'],
    entityTypes: ['STORE', 'PRODUCT', 'COLLECTION', 'LANDING_PAGE'],
    questions: ['Where does the funnel leak?', 'What is cart abandonment?', 'Which landing pages or products convert poorly?'],
    caveats: ['Observed behavior is not causal proof.', 'Pixel rollup freshness and identity-resolution quality must be considered.'],
  },
  {
    domain: 'ATTRIBUTION',
    description: 'First-party journeys and attribution evidence kept separate from provider-reported attribution.',
    sourceOfTruth: ['Stride Pixel journeys', 'Shopify purchase linkage', 'tracked campaign parameters/referrers'],
    entityTypes: ['STORE', 'SESSION', 'PRODUCT', 'CAMPAIGN'],
    questions: ['What paths lead to purchases?', 'How does first-party evidence compare with provider attribution?'],
    caveats: ['Attribution precision varies with tracking and identity linkage; limitations must travel with the answer.'],
  },
  {
    domain: 'PRODUCT_ADS',
    description: 'Cross-domain mapping between Shopify product economics and exact/confirmed paid-media exposure.',
    sourceOfTruth: ['Shopify commerce', 'Meta insights', 'Stride product-ad mappings'],
    entityTypes: ['PRODUCT', 'VARIANT', 'AD'],
    questions: ['Which products receive ad spend?', 'Is mapped spend profitable?', 'How complete is mapping coverage?'],
    caveats: ['Only exact single-product mappings are allocated directly; shared/multi-product spend remains explicit.'],
  },
  {
    domain: 'RECOMMENDATIONS',
    description: 'Stride deterministic findings, priorities, evidence, confidence, limitations and recommendation lifecycle.',
    sourceOfTruth: ['Stride deterministic intelligence engine'],
    entityTypes: ['STORE', 'CAMPAIGN', 'AD_SET', 'AD', 'CREATIVE', 'PRODUCT', 'VARIANT', 'COLLECTION', 'LANDING_PAGE'],
    questions: ['What should I look at first?', 'Why did Stride flag this?', 'What evidence supports the suggested action?'],
    caveats: ['Recommendations are read-only advice in V1; Stride does not execute ad or Shopify mutations.'],
  },
  {
    domain: 'DATA_QUALITY',
    description: 'Connection readiness, sync freshness, evidence quality, coverage and explicit limitations.',
    sourceOfTruth: ['provider sync state', 'Pixel health', 'Stride intelligence quality checks'],
    entityTypes: ['STORE', 'INTEGRATION'],
    questions: ['Can I trust this answer?', 'What data is missing?', 'What should be refreshed or connected?'],
    caveats: ['A healthy connection does not imply every metric has enough sample size for a strong conclusion.'],
  },
  {
    domain: 'HISTORY',
    description: 'Historical analytics windows and reports with current/comparison periods and deterministic evidence.',
    sourceOfTruth: ['Stride analytics workspaces', 'Stride intelligence snapshots'],
    entityTypes: ['STORE'],
    questions: ['What changed versus the previous period?', 'How did the business perform in a specific date range?'],
    caveats: ['Historical methodology follows each source domain and is included with the returned evidence.'],
  },
] as const;

export function knowledgeCatalog() {
  return BUSINESS_KNOWLEDGE_CATALOG.map((entry) => ({ ...entry }));
}
