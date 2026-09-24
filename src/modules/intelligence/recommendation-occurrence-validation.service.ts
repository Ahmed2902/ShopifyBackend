import { AppError } from '../../errors/app-error.js';
import type {
  UnifiedAdvertisingProviderFilter,
  UnifiedAdvertisingRangeQuery,
} from '../advertising/unified-advertising.schema.js';
import {
  unifiedAdvertisingScopeService,
  type UnifiedAdvertisingScopeService,
} from '../advertising/unified-advertising-scope.service.js';
import {
  intelligenceSnapshotReadService,
  type IntelligenceSnapshotReadService,
} from './intelligence-snapshot.read.service.js';
import {
  recommendationOccurrenceKey,
  type RecommendationOccurrenceInput,
} from './recommendation-lifecycle.service.js';
import {
  unifiedDecisionService,
  type UnifiedDecisionService,
} from './unified-decision.service.js';

const PROVIDER_FILTERS: readonly UnifiedAdvertisingProviderFilter[] = [
  'ALL',
  'META',
  'TIKTOK',
  'GOOGLE_ADS',
];
const OCCURRENCE_WINDOW_PATTERN =
  /:(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}\.\d{3}Z:(\d{4}-\d{2}-\d{2})T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;

type IssuedRecommendation = RecommendationOccurrenceInput & { occurrenceKey?: string };
type UnifiedScopeCandidate = Pick<
  UnifiedAdvertisingRangeQuery,
  'provider' | 'accountId' | 'currency'
>;

function containsOccurrence(
  recommendations: readonly IssuedRecommendation[],
  occurrenceKey: string,
): boolean {
  return recommendations.some(
    (recommendation) =>
      recommendation.occurrenceKey === occurrenceKey ||
      recommendationOccurrenceKey(recommendation) === occurrenceKey,
  );
}

function occurrenceWindow(occurrenceKey: string) {
  const match = OCCURRENCE_WINDOW_PATTERN.exec(occurrenceKey);
  return match ? { from: match[1]!, to: match[2]! } : null;
}

function unavailableProviderScope(error: unknown): boolean {
  return (
    error instanceof AppError &&
    (error.code === 'PLAN_AD_CHANNEL_LIMIT' || error.code === 'PLAN_CHANNEL_SELECTION_REQUIRED')
  );
}

function pushScope(
  scopes: UnifiedScopeCandidate[],
  seen: Set<string>,
  scope: UnifiedScopeCandidate,
) {
  const key = `${scope.provider}:${scope.accountId ?? ''}:${scope.currency ?? ''}`;
  if (seen.has(key)) return;
  seen.add(key);
  scopes.push(scope);
}

/**
 * Resolves the authoritative recommendation occurrences that may be mutated for one Store.
 * Legacy recommendations remain supported while unified decisions are validated through the same
 * deterministic read path that issued them. The caller still passes the resulting set to the one
 * lifecycle persistence service, so no duplicate lifecycle state store is introduced.
 */
export class RecommendationOccurrenceValidationService {
  constructor(
    private readonly legacyReads: IntelligenceSnapshotReadService = intelligenceSnapshotReadService,
    private readonly unifiedReads: UnifiedDecisionService = unifiedDecisionService,
    private readonly advertisingScope: UnifiedAdvertisingScopeService =
      unifiedAdvertisingScopeService,
  ) {}

  private async unifiedScopeCandidates(storeId: string): Promise<UnifiedScopeCandidate[]> {
    const scopes: UnifiedScopeCandidate[] = [];
    const seen = new Set<string>();

    // Preserve the previously supported provider-wide replays first. Most occurrences validate on
    // the first ALL read and avoid any additional scope discovery work.
    for (const provider of PROVIDER_FILTERS) pushScope(scopes, seen, { provider });

    let accounts: Awaited<ReturnType<UnifiedAdvertisingScopeService['resolve']>>['accounts'] = [];
    try {
      accounts = (
        await this.advertisingScope.resolve({
          storeId,
          provider: 'ALL',
        })
      ).accounts;
    } catch (error) {
      // A selection-required/plan-limited Store cannot have issued an occurrence from the blocked
      // ALL scope. Keep provider-wide validation behavior and let those canonical entitlement
      // errors be skipped below rather than weakening authorization.
      if (!unavailableProviderScope(error)) throw error;
    }

    // Account-scoped decision reads can reorder or bound the recommendation set differently from a
    // provider-wide read. Reconstruct every currently authorized selected account scope so an
    // occurrence that was genuinely issued under accountId remains mutable.
    for (const account of accounts) {
      pushScope(scopes, seen, { provider: 'ALL', accountId: account.id });
      pushScope(scopes, seen, { provider: account.provider, accountId: account.id });
      pushScope(scopes, seen, {
        provider: 'ALL',
        accountId: account.id,
        currency: account.currency,
      });
      pushScope(scopes, seen, {
        provider: account.provider,
        accountId: account.id,
        currency: account.currency,
      });
    }

    // Currency filtering can likewise narrow the evaluation universe without selecting one account.
    // Reconstruct provider × currency scopes only from currently authorized selected accounts; no
    // arbitrary currency supplied by the client is trusted for lifecycle authorization.
    const currencies = [...new Set(accounts.map((account) => account.currency))];
    for (const currency of currencies) {
      for (const provider of PROVIDER_FILTERS) {
        pushScope(scopes, seen, { provider, currency });
      }
    }

    return scopes;
  }

  async currentRecommendations(
    storeId: string,
    occurrenceKey: string,
    limit: number,
  ): Promise<RecommendationOccurrenceInput[]> {
    const legacySnapshot = await this.legacyReads.read(storeId, { fresh: false });
    const legacy = legacySnapshot.recommendations.slice(0, limit);
    if (containsOccurrence(legacy, occurrenceKey)) return legacy;

    const window = occurrenceWindow(occurrenceKey);
    const scopes = await this.unifiedScopeCandidates(storeId);
    for (const scope of scopes) {
      try {
        const unified = await this.unifiedReads.read(storeId, {
          days: 30,
          ...(window ?? {}),
          ...scope,
        });
        const visible = unified.recommendations.slice(0, limit);
        if (containsOccurrence(visible, occurrenceKey)) {
          return [...legacy, ...visible];
        }
      } catch (error) {
        // An Essentials store can legitimately be barred from one provider scope. Skip only those
        // canonical entitlement errors; subscription/auth/data failures must remain visible.
        if (unavailableProviderScope(error)) continue;
        throw error;
      }
    }

    // RecommendationLifecycleService.setState performs the final exact-key check and returns the
    // established RECOMMENDATION_OCCURRENCE_NOT_FOUND response for fabricated/stale occurrences.
    return legacy;
  }
}

export const recommendationOccurrenceValidationService =
  new RecommendationOccurrenceValidationService();
