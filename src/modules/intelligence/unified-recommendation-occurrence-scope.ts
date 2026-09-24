import {
  unifiedAdvertisingRangeQuerySchema,
  type UnifiedAdvertisingRangeQuery,
} from '../advertising/unified-advertising.schema.js';

const UNIFIED_OCCURRENCE_SCOPE_VERSION = 'u1';

export type ScopedUnifiedRecommendationOccurrence = {
  canonicalOccurrenceKey: string;
  query: UnifiedAdvertisingRangeQuery;
};

/**
 * Carries the exact unified-decision read scope alongside the public occurrence key.
 *
 * Lifecycle persistence still uses the canonical recommendation occurrence key. The scoped key is
 * only the mutation handle returned by the unified HTTP surface so validation can deterministically
 * replay exactly one authorized read rather than guessing/replaying every account/currency scope.
 */
export function scopeUnifiedRecommendationOccurrenceKey(
  canonicalOccurrenceKey: string,
  query: UnifiedAdvertisingRangeQuery,
): string {
  return [
    UNIFIED_OCCURRENCE_SCOPE_VERSION,
    query.provider,
    query.accountId ?? '',
    query.currency ?? '',
    query.from ?? '',
    query.to ?? '',
    String(query.days),
    canonicalOccurrenceKey,
  ].join('|');
}

/**
 * Parses a scoped unified occurrence handle using the authoritative public query schema. A forged
 * scope is not trusted: callers must replay the parsed query through the normal store/billing/
 * advertising-scope services and verify that the canonical occurrence is actually visible there.
 */
export function parseScopedUnifiedRecommendationOccurrenceKey(
  value: string,
): ScopedUnifiedRecommendationOccurrence | null {
  const parts = value.split('|');
  if (parts.length < 8 || parts[0] !== UNIFIED_OCCURRENCE_SCOPE_VERSION) return null;

  const [, provider, accountId, currency, from, to, days, ...canonicalParts] = parts;
  const canonicalOccurrenceKey = canonicalParts.join('|');
  if (!canonicalOccurrenceKey) return null;

  const parsed = unifiedAdvertisingRangeQuerySchema.safeParse({
    provider,
    accountId: accountId || undefined,
    currency: currency || undefined,
    from: from || undefined,
    to: to || undefined,
    days,
  });
  if (!parsed.success) return null;

  return {
    canonicalOccurrenceKey,
    query: parsed.data,
  };
}
