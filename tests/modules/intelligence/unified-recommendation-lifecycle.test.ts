import { randomUUID } from 'node:crypto';
import type { Request, Response } from 'express';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  analyticsWorkspaceCachedReads,
  dashboardCachedReads,
  intelligenceSnapshotCachedReads,
} from '../../../src/lib/store-decision-cache.js';
import { prisma } from '../../../src/lib/prisma.js';
import { IntelligenceController } from '../../../src/modules/intelligence/intelligence.controller.js';
import type { RecommendationDraft } from '../../../src/modules/intelligence/intelligence.types.js';
import {
  RecommendationLifecycleService,
  recommendationOccurrenceKey,
} from '../../../src/modules/intelligence/recommendation-lifecycle.service.js';
import { RecommendationOccurrenceValidationService } from '../../../src/modules/intelligence/recommendation-occurrence-validation.service.js';
import { scopeUnifiedRecommendationOccurrenceKey } from '../../../src/modules/intelligence/unified-recommendation-occurrence-scope.js';

const storeId = '11111111-1111-4111-8111-111111111111';
const otherStoreId = '22222222-2222-4222-8222-222222222222';
const accountId = '44444444-4444-4444-8444-444444444444';
const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const databaseStores: string[] = [];

function occurrence(ruleId: string, entityId: string | null = null) {
  return {
    ruleId,
    ruleVersion: '1',
    entityType: entityId ? ('PRODUCT' as const) : ('STORE' as const),
    entityId,
    externalEntityId: null,
    title: ruleId,
    observationStart: new Date('2026-09-01T00:00:00.000Z'),
    observationEnd: new Date('2026-09-24T00:00:00.000Z'),
  };
}

function decorated(ruleId: string, entityId: string | null = null) {
  const value = occurrence(ruleId, entityId);
  return { ...value, occurrenceKey: recommendationOccurrenceKey(value) };
}

function validator(input: {
  legacyByStore?: Record<string, ReturnType<typeof occurrence>[]>;
  unifiedByStore?: Record<string, ReturnType<typeof decorated>[]>;
  unifiedRead?: (
    requestedStoreId: string,
    query: Record<string, unknown>,
  ) => Promise<{ recommendations: ReturnType<typeof decorated>[] }>;
}) {
  const legacyReads = {
    read: vi.fn(async (requestedStoreId: string) => ({
      recommendations: input.legacyByStore?.[requestedStoreId] ?? [],
    })),
  };
  const unifiedReads = {
    read: vi.fn(async (requestedStoreId: string, query: Record<string, unknown>) => {
      if (input.unifiedRead) return input.unifiedRead(requestedStoreId, query);
      return { recommendations: input.unifiedByStore?.[requestedStoreId] ?? [] };
    }),
  };
  return {
    service: new RecommendationOccurrenceValidationService(
      legacyReads as never,
      unifiedReads as never,
    ),
    legacyReads,
    unifiedReads,
  };
}

describe('Unified recommendation occurrence validation', () => {
  it('replays exactly the scope carried by a backend-issued unified occurrence', async () => {
    const unified = decorated('unified_product_signal', '33333333-3333-4333-8333-333333333333');
    const publicKey = scopeUnifiedRecommendationOccurrenceKey(unified.occurrenceKey, {
      provider: 'META',
      accountId,
      currency: 'EUR',
      from: '2026-09-01',
      to: '2026-09-24',
      days: 30,
    });
    const { service, unifiedReads } = validator({ unifiedByStore: { [storeId]: [unified] } });

    const current = await service.currentRecommendations(storeId, publicKey, 10);

    expect(current.canonicalOccurrenceKey).toBe(unified.occurrenceKey);
    expect(
      current.recommendations.some(
        (item) => recommendationOccurrenceKey(item) === unified.occurrenceKey,
      ),
    ).toBe(true);
    expect(unifiedReads.read).toHaveBeenCalledTimes(1);
    expect(unifiedReads.read).toHaveBeenCalledWith(storeId, {
      provider: 'META',
      accountId,
      currency: 'EUR',
      from: '2026-09-01',
      to: '2026-09-24',
      days: 30,
    });
  });

  it('preserves an arbitrary issued currency even when no advertising account supplies it', async () => {
    const unified = decorated('unified_currency_mismatch');
    const publicKey = scopeUnifiedRecommendationOccurrenceKey(unified.occurrenceKey, {
      provider: 'ALL',
      currency: 'EUR',
      days: 30,
    });
    const { service, unifiedReads } = validator({
      unifiedRead: async (_requestedStoreId, query) => ({
        recommendations: query.currency === 'EUR' ? [unified] : [],
      }),
    });

    const current = await service.currentRecommendations(storeId, publicKey, 10);

    expect(current.canonicalOccurrenceKey).toBe(unified.occurrenceKey);
    expect(unifiedReads.read).toHaveBeenCalledTimes(1);
    expect(unifiedReads.read).toHaveBeenCalledWith(
      storeId,
      expect.objectContaining({ provider: 'ALL', currency: 'EUR' }),
    );
  });

  it('retains legacy occurrence compatibility without requiring a unified read', async () => {
    const legacy = occurrence('legacy_inventory_signal');
    const key = recommendationOccurrenceKey(legacy);
    const { service, unifiedReads } = validator({ legacyByStore: { [storeId]: [legacy] } });

    const current = await service.currentRecommendations(storeId, key, 10);

    expect(current).toEqual({ canonicalOccurrenceKey: key, recommendations: [legacy] });
    expect(unifiedReads.read).not.toHaveBeenCalled();
  });

  it('keeps one bounded default-scope replay for pre-hotfix unified occurrence keys', async () => {
    const unified = decorated('unified_pre_hotfix');
    const { service, unifiedReads } = validator({ unifiedByStore: { [storeId]: [unified] } });

    const current = await service.currentRecommendations(storeId, unified.occurrenceKey, 10);

    expect(current.canonicalOccurrenceKey).toBe(unified.occurrenceKey);
    expect(unifiedReads.read).toHaveBeenCalledTimes(1);
    expect(unifiedReads.read).toHaveBeenCalledWith(
      storeId,
      expect.objectContaining({
        provider: 'ALL',
        from: '2026-09-01',
        to: '2026-09-24',
      }),
    );
  });

  it('rejects a fabricated scoped occurrence after exactly one unified replay', async () => {
    const fabricatedCanonical =
      'fabricated:1:STORE:x:2026-09-01T00:00:00.000Z:2026-09-24T00:00:00.000Z';
    const publicKey = scopeUnifiedRecommendationOccurrenceKey(fabricatedCanonical, {
      provider: 'ALL',
      currency: 'EUR',
      days: 30,
    });
    const { service, unifiedReads } = validator({});
    const lifecycle = new RecommendationLifecycleService();
    const current = await service.currentRecommendations(storeId, publicKey, 10);

    expect(unifiedReads.read).toHaveBeenCalledTimes(1);
    await expect(
      lifecycle.setState(
        storeId,
        current.canonicalOccurrenceKey,
        'DISMISSED',
        current.recommendations,
      ),
    ).rejects.toMatchObject({
      code: 'RECOMMENDATION_OCCURRENCE_NOT_FOUND',
      statusCode: 404,
    });
  });

  it('does not authorize an occurrence issued by another store', async () => {
    const other = decorated('unified_other_store_signal');
    const publicKey = scopeUnifiedRecommendationOccurrenceKey(other.occurrenceKey, {
      provider: 'ALL',
      days: 30,
    });
    const { service, unifiedReads } = validator({
      unifiedRead: async (requestedStoreId) => ({
        recommendations: requestedStoreId === otherStoreId ? [other] : [],
      }),
    });
    const lifecycle = new RecommendationLifecycleService();
    const current = await service.currentRecommendations(storeId, publicKey, 10);

    expect(unifiedReads.read).toHaveBeenCalledTimes(1);
    await expect(
      lifecycle.setState(
        storeId,
        current.canonicalOccurrenceKey,
        'REVIEWED',
        current.recommendations,
      ),
    ).rejects.toMatchObject({ code: 'RECOMMENDATION_OCCURRENCE_NOT_FOUND' });
  });

  it('validates only recommendations visible under the supplied entitlement cap', async () => {
    const first = decorated('unified_first');
    const second = decorated('unified_second');
    const publicKey = scopeUnifiedRecommendationOccurrenceKey(second.occurrenceKey, {
      provider: 'ALL',
      days: 30,
    });
    const { service } = validator({ unifiedByStore: { [storeId]: [first, second] } });

    const current = await service.currentRecommendations(storeId, publicKey, 1);

    expect(
      current.recommendations.some(
        (item) => recommendationOccurrenceKey(item) === second.occurrenceKey,
      ),
    ).toBe(false);
  });
});

describe('Unified lifecycle cache coherence', () => {
  it('persists the canonical key, returns the public scoped handle, and invalidates decision caches', async () => {
    const issued = occurrence('unified_cache_state');
    const canonicalOccurrenceKey = recommendationOccurrenceKey(issued);
    const publicOccurrenceKey = scopeUnifiedRecommendationOccurrenceKey(canonicalOccurrenceKey, {
      provider: 'ALL',
      currency: 'EUR',
      days: 30,
    });
    const occurrenceValidation = {
      currentRecommendations: vi.fn().mockResolvedValue({
        canonicalOccurrenceKey,
        recommendations: [issued],
      }),
    };
    const lifecycle = {
      setState: vi.fn().mockResolvedValue({
        occurrenceKey: canonicalOccurrenceKey,
        state: 'REVIEWED',
      }),
      attach: vi.fn(),
    };
    const analyticsInvalidate = vi
      .spyOn(analyticsWorkspaceCachedReads, 'invalidate')
      .mockResolvedValue(undefined);
    const dashboardInvalidate = vi
      .spyOn(dashboardCachedReads, 'invalidate')
      .mockResolvedValue(undefined);
    const intelligenceInvalidate = vi
      .spyOn(intelligenceSnapshotCachedReads, 'invalidate')
      .mockResolvedValue(undefined);
    const controller = new IntelligenceController(
      {} as never,
      {} as never,
      occurrenceValidation as never,
      lifecycle as never,
    );
    const req = {
      context: { storeId },
      body: { occurrenceKey: publicOccurrenceKey, state: 'REVIEWED' },
    } as unknown as Request;
    const res = {
      locals: { billing: { entitlements: { recommendationLimit: 10 } } },
      status: vi.fn(),
      json: vi.fn(),
    } as unknown as Response;
    vi.mocked(res.status).mockReturnValue(res);

    await controller.updateRecommendationLifecycle(req, res);

    expect(lifecycle.setState).toHaveBeenCalledWith(
      storeId,
      canonicalOccurrenceKey,
      'REVIEWED',
      [issued],
    );
    expect(analyticsInvalidate).toHaveBeenCalledWith(storeId);
    expect(dashboardInvalidate).toHaveBeenCalledWith(storeId);
    expect(intelligenceInvalidate).toHaveBeenCalledWith(storeId);
    expect(res.json).toHaveBeenCalledWith({
      occurrenceKey: publicOccurrenceKey,
      state: 'REVIEWED',
    });
  });
});

function lifecycleDraft(): RecommendationDraft & { priority: number } {
  return {
    ruleId: 'unified_lifecycle_regression',
    ruleVersion: '1',
    category: 'DATA_QUALITY',
    severity: 'MEDIUM',
    entityType: 'STORE',
    entityId: null,
    externalEntityId: null,
    title: 'Unified lifecycle regression',
    summary: 'Lifecycle regression fixture',
    suggestedAction: 'Review fixture.',
    impactScore: 0.5,
    confidenceScore: 0.5,
    urgencyScore: 0.5,
    evidenceQuality: 'MEDIUM',
    attributionPrecision: 'UNKNOWN',
    limitations: [],
    observationStart: new Date('2026-09-01T00:00:00.000Z'),
    observationEnd: new Date('2026-09-24T00:00:00.000Z'),
    comparisonStart: new Date('2026-08-08T00:00:00.000Z'),
    comparisonEnd: new Date('2026-08-31T00:00:00.000Z'),
    evidence: { source: 'test' },
    priority: 0.5,
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  for (const id of databaseStores.splice(0)) {
    await prisma.store.delete({ where: { id } }).catch(() => undefined);
  }
});

describeDatabase('Unified recommendation lifecycle persistence', () => {
  it('supports review, dismiss, resolve and reopen and reflects state on the next unified attach', async () => {
    const suffix = randomUUID();
    const store = await prisma.store.create({
      data: {
        shopifyShopId: `gid://shopify/Shop/${suffix}`,
        name: 'Unified lifecycle',
        myshopifyDomain: `unified-lifecycle-${suffix}.myshopify.com`,
        currencyCode: 'USD',
        ianaTimezone: 'UTC',
      },
    });
    databaseStores.push(store.id);
    const lifecycle = new RecommendationLifecycleService();
    const draft = lifecycleDraft();
    const issued = await lifecycle.attach(store.id, [draft]);
    const key = issued[0]!.occurrenceKey;

    await expect(lifecycle.setState(store.id, key, 'REVIEWED', [draft])).resolves.toMatchObject({
      occurrenceKey: key,
      state: 'REVIEWED',
    });
    await expect(lifecycle.setState(store.id, key, 'DISMISSED', [draft])).resolves.toMatchObject({
      occurrenceKey: key,
      state: 'DISMISSED',
    });
    await expect(lifecycle.setState(store.id, key, 'RESOLVED', [draft])).resolves.toMatchObject({
      occurrenceKey: key,
      state: 'RESOLVED',
    });

    const resolved = await lifecycle.attach(store.id, [draft]);
    expect(resolved[0]).toMatchObject({ occurrenceKey: key, lifecycleState: 'RESOLVED' });

    await expect(lifecycle.setState(store.id, key, 'OPEN', [draft])).resolves.toMatchObject({
      occurrenceKey: key,
      state: 'OPEN',
    });
    const reopened = await lifecycle.attach(store.id, [draft]);
    expect(reopened[0]).toMatchObject({ occurrenceKey: key, lifecycleState: 'OPEN' });
  });
});
