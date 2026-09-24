import type { Response } from 'express';

/**
 * Authoritative HTTP recommendation cap shared by legacy and unified decision surfaces.
 * Preserve the established product semantics: missing entitlement defaults to 10 and the
 * effective cap never falls below one recommendation.
 */
export function recommendationLimit(res: Response): number {
  return Math.max(
    1,
    Number(res.locals.billing?.entitlements?.recommendationLimit ?? 10),
  );
}

export function limitRecommendations<T>(res: Response, recommendations: readonly T[]): T[] {
  return recommendations.slice(0, recommendationLimit(res));
}
