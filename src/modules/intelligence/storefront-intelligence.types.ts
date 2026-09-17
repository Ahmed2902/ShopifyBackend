export interface StorefrontBehaviorPeriod {
  sessions: number;
  productViewSessions: number;
  addToCartSessions: number;
  cartViewSessions: number;
  cartViewCheckoutSessions: number;
  cartViewPurchaseSessions: number;
  checkoutStartSessions: number;
  linkedPurchaseSessions: number;
  productViewRate: number | null;
  viewToCartRate: number | null;
  cartViewToCheckoutRate: number | null;
  cartViewToPurchaseRate: number | null;
  cartAbandonmentRate: number | null;
  checkoutCompletionRate: number | null;
  checkoutAbandonmentRate: number | null;
  linkedPurchaseRate: number | null;
  largestFunnelDropStage: 'SESSION_TO_PRODUCT' | 'PRODUCT_TO_CART' | 'CART_TO_CHECKOUT' | 'CHECKOUT_TO_PURCHASE' | null;
  largestFunnelDropRate: number | null;
}

export interface StorefrontEvidence {
  current: StorefrontBehaviorPeriod;
  comparison: StorefrontBehaviorPeriod;
  evidenceQuality: 'HIGH' | 'MEDIUM' | 'LOW';
  limitations: Array<{ code: string; message: string }>;
  observationStart: Date;
  observationEnd: Date;
  comparisonStart: Date;
  comparisonEnd: Date;
}

export interface StorefrontDimensionEvidence extends StorefrontEvidence {
  entityType: 'PRODUCT' | 'LANDING_PAGE';
  entityId: string | null;
  externalEntityId: string | null;
  name: string;
}
