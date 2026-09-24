import { describe, expect, it, vi } from 'vitest';
import { AppError } from '../../../src/errors/app-error.js';
import { MCP_TOOLS, McpToolExecutor } from '../../../src/modules/mcp/mcp-tools.js';

const storeId = '11111111-1111-4111-8111-111111111111';
const entityId = '22222222-2222-4222-8222-222222222222';

function reads() {
  return {
    context: vi.fn(),
    snapshot: vi.fn(),
    search: vi.fn(),
    overview: vi.fn(),
    performance: vi.fn(),
    products: vi.fn(),
    product: vi.fn(),
    productLeaderboard: vi.fn(),
    collections: vi.fn(),
    collectionDetail: vi.fn(),
    customers: vi.fn(),
    inventory: vi.fn(),
    paidMediaOverview: vi.fn(),
    paidMediaList: vi.fn(),
    paidMediaDetail: vi.fn(),
    adExposureList: vi.fn(),
    adExposureDetail: vi.fn(),
    storefrontOverview: vi.fn(),
    storefrontProducts: vi.fn(),
    storefrontCollections: vi.fn(),
    storefrontLandingPages: vi.fn(),
    attributionSources: vi.fn(),
    attributionMetaAds: vi.fn(),
    attributionPaths: vi.fn(),
    attributionMappings: vi.fn(),
    productAdsList: vi.fn(),
    productAdsDetail: vi.fn(),
    intelligenceSettings: vi.fn(),
    inventoryPlanningSettings: vi.fn(),
    recommendations: vi.fn(),
    report: vi.fn(),
  };
}

function billing() {
  return {
    requireEntitlement: vi.fn().mockResolvedValue({ effectivePlan: 'PRO' }),
    requireActive: vi.fn().mockResolvedValue({
      effectivePlan: 'PRO',
      essentialsAdProvider: null,
      entitlements: { recommendationLimit: 10, maxAdChannels: null },
    }),
    requireAdProviderReadOnly: vi.fn().mockResolvedValue({ effectivePlan: 'PRO' }),
  };
}

function lifecycle() {
  return {
    attach: vi.fn().mockImplementation(async (_storeId: string, recommendations: unknown[]) =>
      recommendations.map((recommendation, index) => ({
        ...(recommendation as object),
        occurrenceKey: `occ-${index}`,
        lifecycleState: index === 0 ? 'DISMISSED' : 'OPEN',
        lifecycleUpdatedAt: index === 0 ? new Date('2026-09-20T10:00:00.000Z') : null,
      })),
    ),
  };
}

describe('Stride MCP tools', () => {
  it('exposes only read-only tools with no caller-controlled store id', () => {
    for (const tool of MCP_TOOLS) {
      expect(tool.annotations).toMatchObject({
        readOnlyHint: true,
        destructiveHint: false,
        idempotentHint: true,
      });
      expect(JSON.stringify(tool.inputSchema)).not.toContain('storeId');
    }
  });

  it('routes collection detail through the OAuth-bound store', async () => {
    const value = reads();
    value.collectionDetail.mockResolvedValue({ collection: { id: entityId } });
    const executor = new McpToolExecutor(value as never, billing() as never);

    await executor.call(storeId, 'stride_get_commerce', {
      surface: 'collection_detail',
      entityId,
      page: 2,
      limit: 10,
    });

    expect(value.collectionDetail).toHaveBeenCalledWith(storeId, entityId, {
      surface: 'collection_detail',
      entityId,
      page: 2,
      limit: 10,
    });
  });

  it('routes daily performance and product leaderboard reads', async () => {
    const value = reads();
    const executor = new McpToolExecutor(value as never, billing() as never);

    await executor.call(storeId, 'stride_get_commerce', { surface: 'performance', days: 21 });
    await executor.call(storeId, 'stride_get_commerce', {
      surface: 'product_leaderboard',
      days: 21,
      limit: 8,
    });

    expect(value.performance).toHaveBeenCalledWith(storeId, 21);
    expect(value.productLeaderboard).toHaveBeenCalledWith(storeId, {
      surface: 'product_leaderboard',
      days: 21,
      limit: 8,
    });
  });

  it('keeps ad exposure explicitly Meta-only and rejects unsupported calls before billing work', async () => {
    const value = reads();
    const plan = billing();
    const executor = new McpToolExecutor(value as never, plan as never);

    await expect(
      executor.call(storeId, 'stride_get_paid_media', {
        provider: 'TIKTOK',
        action: 'ad_exposure_list',
        days: 30,
      }),
    ).rejects.toThrow('supported only for provider=META');
    expect(value.adExposureList).not.toHaveBeenCalled();
    expect(plan.requireAdProviderReadOnly).not.toHaveBeenCalled();

    await executor.call(storeId, 'stride_get_paid_media', {
      provider: 'META',
      action: 'ad_exposure_detail',
      entityId,
      days: 30,
    });
    expect(value.adExposureDetail).toHaveBeenCalledWith(storeId, entityId, 30);
    expect(plan.requireAdProviderReadOnly).toHaveBeenCalledTimes(1);
  });

  it('enforces provider entitlement without using the mutating provider guard', async () => {
    const value = reads();
    const plan = billing();
    plan.requireAdProviderReadOnly.mockRejectedValueOnce(
      new AppError('Essentials includes one advertising channel.', 403, 'PLAN_AD_CHANNEL_LIMIT'),
    );
    const executor = new McpToolExecutor(value as never, plan as never);

    await expect(
      executor.call(storeId, 'stride_get_paid_media', {
        provider: 'META',
        action: 'overview',
      }),
    ).rejects.toMatchObject({ code: 'PLAN_AD_CHANNEL_LIMIT' });

    expect(plan.requireAdProviderReadOnly).toHaveBeenCalledWith(storeId, 'META');
    expect(value.paidMediaOverview).not.toHaveBeenCalled();
  });

  it('short-circuits broad search from an already selected Essentials provider', async () => {
    const value = reads();
    value.search.mockResolvedValue({
      query: 'prospecting',
      searchedEntityTypes: ['CAMPAIGN'],
      paidMediaProvidersSearched: ['META'],
      totalMatches: 1,
      truncated: false,
      items: [{ type: 'CAMPAIGN', provider: 'META', name: 'Meta Prospecting' }],
      privacy: 'Business entities only',
    });
    const plan = billing();
    plan.requireActive.mockResolvedValue({
      effectivePlan: 'ESSENTIALS',
      essentialsAdProvider: 'META',
      entitlements: { recommendationLimit: 10, maxAdChannels: 1 },
    });
    const executor = new McpToolExecutor(value as never, plan as never);

    const result = await executor.call(storeId, 'stride_search', {
      query: 'prospecting',
      entityTypes: ['CAMPAIGN'],
    });

    expect(plan.requireActive).toHaveBeenCalledTimes(1);
    expect(plan.requireAdProviderReadOnly).not.toHaveBeenCalled();
    expect(value.search).toHaveBeenCalledWith(storeId, {
      query: 'prospecting',
      entityTypes: ['CAMPAIGN'],
      paidMediaProviders: ['META'],
    });
    expect(result.paidMediaAccess).toEqual({
      allowedProviders: ['META'],
      blockedProviders: [
        {
          provider: 'TIKTOK',
          code: 'PLAN_AD_CHANNEL_LIMIT',
          message:
            'Essentials includes one advertising channel. Choose the existing channel or upgrade to Pro.',
        },
        {
          provider: 'GOOGLE_ADS',
          code: 'PLAN_AD_CHANNEL_LIMIT',
          message:
            'Essentials includes one advertising channel. Choose the existing channel or upgrade to Pro.',
        },
      ],
    });
  });

  it('uses one plan read and no per-provider guards for multi-channel search', async () => {
    const value = reads();
    value.search.mockResolvedValue({ items: [], totalMatches: 0, truncated: false });
    const plan = billing();
    const executor = new McpToolExecutor(value as never, plan as never);

    await executor.call(storeId, 'stride_search', {
      query: 'campaign',
      entityTypes: ['CAMPAIGN', 'AD'],
    });

    expect(plan.requireActive).toHaveBeenCalledTimes(1);
    expect(plan.requireAdProviderReadOnly).not.toHaveBeenCalled();
    expect(value.search).toHaveBeenCalledWith(storeId, {
      query: 'campaign',
      entityTypes: ['CAMPAIGN', 'AD'],
      paidMediaProviders: ['META', 'TIKTOK', 'GOOGLE_ADS'],
    });
  });

  it('falls back to read-only provider guards only when Essentials has no selection yet', async () => {
    const value = reads();
    value.search.mockResolvedValue({ items: [], totalMatches: 0, truncated: false });
    const plan = billing();
    plan.requireActive.mockResolvedValue({
      effectivePlan: 'ESSENTIALS',
      essentialsAdProvider: null,
      entitlements: { recommendationLimit: 10, maxAdChannels: 1 },
    });
    plan.requireAdProviderReadOnly.mockImplementation(async (_store: string, provider: string) => {
      if (provider === 'META') return { effectivePlan: 'ESSENTIALS' };
      throw new AppError(
        'Essentials includes one advertising channel.',
        403,
        'PLAN_AD_CHANNEL_LIMIT',
      );
    });
    const executor = new McpToolExecutor(value as never, plan as never);

    const result = await executor.call(storeId, 'stride_search', {
      query: 'prospecting',
      entityTypes: ['CAMPAIGN'],
    });

    expect(plan.requireActive).toHaveBeenCalledTimes(1);
    expect(plan.requireAdProviderReadOnly).toHaveBeenCalledTimes(3);
    expect(result.paidMediaAccess.allowedProviders).toEqual(['META']);
    expect(result.paidMediaAccess.blockedProviders).toHaveLength(2);
    expect(result.paidMediaAccess.blockedProviders.map((item) => item.provider)).toEqual([
      'TIKTOK',
      'GOOGLE_ADS',
    ]);
  });

  it('preserves the Pro entitlement for advanced Pixel attribution', async () => {
    const value = reads();
    const plan = billing();
    const executor = new McpToolExecutor(value as never, plan as never);

    await executor.call(storeId, 'stride_get_attribution', {
      surface: 'paths',
      days: 30,
      page: 1,
      limit: 10,
    });
    expect(plan.requireEntitlement).toHaveBeenCalledWith(storeId, 'ADVANCED_ATTRIBUTION');
    expect(value.attributionPaths).toHaveBeenCalledTimes(1);

    plan.requireEntitlement.mockRejectedValueOnce(new Error('This feature requires the Pro plan.'));
    await expect(
      executor.call(storeId, 'stride_get_attribution', {
        surface: 'mappings',
        targetType: 'PRODUCT',
      }),
    ).rejects.toThrow('requires the Pro plan');
    expect(value.attributionMappings).not.toHaveBeenCalled();
  });

  it('validates mapping shape before an advanced-attribution billing read', async () => {
    const value = reads();
    const plan = billing();
    const executor = new McpToolExecutor(value as never, plan as never);

    await expect(
      executor.call(storeId, 'stride_get_attribution', { surface: 'mappings' }),
    ).rejects.toThrow('targetType is required');
    expect(plan.requireEntitlement).not.toHaveBeenCalled();
    expect(value.attributionMappings).not.toHaveBeenCalled();
  });

  it('reads decision settings without exposing a write surface', async () => {
    const value = reads();
    value.intelligenceSettings.mockResolvedValue({ inventoryIntelligenceMode: 'TRUSTED' });
    value.inventoryPlanningSettings.mockResolvedValue({
      inventoryRestockLeadTimeDays: 14,
      inventoryLowStockThreshold: 5,
    });
    const executor = new McpToolExecutor(value as never, billing() as never);

    const result = await executor.call(storeId, 'stride_get_decision_settings', {});

    expect(value.intelligenceSettings).toHaveBeenCalledWith(storeId);
    expect(value.inventoryPlanningSettings).toHaveBeenCalledWith(storeId);
    expect(result).toEqual({
      intelligence: { inventoryIntelligenceMode: 'TRUSTED' },
      inventoryPlanning: {
        inventoryRestockLeadTimeDays: 14,
        inventoryLowStockThreshold: 5,
      },
    });
    const tool = MCP_TOOLS.find((candidate) => candidate.name === 'stride_get_decision_settings');
    expect(tool?.annotations).toMatchObject({ readOnlyHint: true, destructiveHint: false });
  });

  it('caps report recommendations before lifecycle decoration and returns persisted state', async () => {
    const value = reads();
    const recommendations = Array.from({ length: 12 }, (_, index) => ({ id: `rec-${index}` }));
    value.report.mockResolvedValue({
      overview: { currency: 'USD' },
      sections: {
        intelligence: {
          available: true,
          data: {
            evaluatedAt: new Date(),
            recommendations,
            dataQuality: [],
          },
        },
      },
    });
    const plan = billing();
    plan.requireActive.mockResolvedValue({ entitlements: { recommendationLimit: 3 } });
    const states = lifecycle();
    const executor = new McpToolExecutor(value as never, plan as never, states as never);

    const result = await executor.call(storeId, 'stride_get_report', { days: 30 });

    expect(plan.requireActive).toHaveBeenCalledWith(storeId);
    expect(states.attach).toHaveBeenCalledWith(storeId, recommendations.slice(0, 3));
    expect(result.sections.intelligence.available).toBe(true);
    if (result.sections.intelligence.available) {
      expect(result.sections.intelligence.data.recommendations).toHaveLength(3);
      expect(result.sections.intelligence.data.recommendations[0]).toMatchObject({
        id: 'rec-0',
        lifecycleState: 'DISMISSED',
        occurrenceKey: 'occ-0',
      });
      expect(result.sections.intelligence.data.entitlement).toEqual({ recommendationLimit: 3 });
    }
  });

  it('does not expose owner/admin-only Pixel health through generic MCP inputs', async () => {
    const value = reads();
    const executor = new McpToolExecutor(value as never, billing() as never);

    await expect(
      executor.call(storeId, 'stride_get_storefront', { surface: 'health' }),
    ).rejects.toBeDefined();
  });

  it('rejects missing detail identifiers and invalid params before any read or billing work', async () => {
    const value = reads();
    const plan = billing();
    const executor = new McpToolExecutor(value as never, plan as never);

    await expect(
      executor.call(storeId, 'stride_get_commerce', { surface: 'collection_detail' }),
    ).rejects.toThrow('entityId is required');
    await expect(
      executor.call(storeId, 'stride_get_paid_media', {
        provider: 'META',
        action: 'detail',
        level: 'AD',
      }),
    ).rejects.toThrow('entityId is required');
    expect(plan.requireAdProviderReadOnly).not.toHaveBeenCalled();
    await expect(
      executor.call(storeId, 'stride_get_storefront', { surface: 'overview', days: 0 }),
    ).rejects.toBeDefined();
  });

  it('rejects unknown tools without falling through to a data read', async () => {
    const value = reads();
    const executor = new McpToolExecutor(value as never, billing() as never);

    await expect(executor.call(storeId, 'stride_delete_campaign', {})).rejects.toThrow(
      'Unknown Stride MCP tool',
    );
  });
});
