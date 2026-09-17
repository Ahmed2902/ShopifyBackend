import type { IntelligenceStorefrontEvidenceRow } from './intelligence-storefront.read.repository.js';
import type {
  StorefrontBehaviorEvidence,
  StorefrontBehaviorMetrics,
} from './intelligence.types.js';

function rate(numerator: number, denominator: number): number | null {
  return denominator > 0 ? numerator / denominator : null;
}

function complement(value: number | null): number | null {
  return value === null ? null : Math.max(0, Math.min(1, 1 - value));
}

function metrics(row: IntelligenceStorefrontEvidenceRow | undefined): StorefrontBehaviorMetrics {
  const sessions = row?.sessionCount ?? 0;
  const productViewSessions = row?.productViewSessionCount ?? 0;
  const addToCartSessions = row?.addToCartSessionCount ?? 0;
  const cartViewSessions = row?.cartViewSessionCount ?? 0;
  const cartViewCheckoutSessions = row?.cartViewCheckoutSessionCount ?? 0;
  const cartViewPurchaseSessions = row?.cartViewPurchaseSessionCount ?? 0;
  const checkoutStartSessions = row?.checkoutStartSessionCount ?? 0;
  const checkoutCompletedSessions = row?.checkoutCompletedSessionCount ?? 0;
  const linkedPurchaseSessions = row?.linkedPurchaseSessionCount ?? 0;
  const cartViewToPurchaseRate = rate(cartViewPurchaseSessions, cartViewSessions);
  const checkoutCompletionRate = rate(checkoutCompletedSessions, checkoutStartSessions);

  return {
    sessions,
    productViewSessions,
    addToCartSessions,
    cartViewSessions,
    cartViewCheckoutSessions,
    cartViewPurchaseSessions,
    checkoutStartSessions,
    checkoutCompletedSessions,
    linkedPurchaseSessions,
    productViewRate: rate(productViewSessions, sessions),
    viewToCartRate: rate(addToCartSessions, productViewSessions),
    cartViewToCheckoutRate: rate(cartViewCheckoutSessions, cartViewSessions),
    cartViewToPurchaseRate,
    cartAbandonmentRate: complement(cartViewToPurchaseRate),
    checkoutCompletionRate,
    checkoutAbandonmentRate: complement(checkoutCompletionRate),
    linkedPurchaseRate: rate(linkedPurchaseSessions, sessions),
  };
}

export function buildStorefrontBehaviorEvidence(
  rows: IntelligenceStorefrontEvidenceRow[],
): StorefrontBehaviorEvidence[] {
  const grouped = new Map<
    string,
    {
      current?: IntelligenceStorefrontEvidenceRow;
      comparison?: IntelligenceStorefrontEvidenceRow;
    }
  >();

  for (const row of rows) {
    const key = `${row.dimension}:${row.dimensionKey}`;
    const value = grouped.get(key) ?? {};
    if (row.period === 'CURRENT') value.current = row;
    else value.comparison = row;
    grouped.set(key, value);
  }

  return [...grouped.values()].map(({ current, comparison }) => {
    const identity = current ?? comparison!;
    return {
      dimension: identity.dimension,
      entityId: identity.productId,
      externalEntityId:
        identity.dimension === 'LANDING_PAGE' ? identity.dimensionKey : identity.productExternalId,
      name:
        identity.dimension === 'STORE'
          ? 'Storefront'
          : identity.dimension === 'PRODUCT'
            ? identity.productTitle ?? identity.productExternalId ?? 'Unresolved product'
            : identity.landingPageUrl ?? 'Landing page',
      current: metrics(current),
      comparison: metrics(comparison),
      sourceRowCount: (current?.sourceRowCount ?? 0) + (comparison?.sourceRowCount ?? 0),
    };
  });
}
