import { afterEach, describe, expect, it, vi } from 'vitest';
import { AppError } from '../../../src/errors/app-error.js';
import { unifiedAdvertisingScopeService } from '../../../src/modules/advertising/unified-advertising-scope.service.js';
import { billingService } from '../../../src/modules/billing/billing.service.js';
import { requireMcpToolEntitlement } from '../../../src/modules/mcp/mcp-entitlement.middleware.js';
import { MCP_TOOLS, McpToolExecutor } from '../../../src/modules/mcp/mcp-tools.js';

const storeId = '11111111-1111-4111-8111-111111111111';
const productId = '22222222-2222-4222-8222-222222222222';

function essentials(selected: 'META' | 'TIKTOK' | 'GOOGLE_ADS' | null) {
  return {
    effectivePlan: 'ESSENTIALS',
    essentialsAdProvider: selected,
    entitlements: { maxAdChannels: 1 },
  };
}

const pro = {
  effectivePlan: 'PRO',
  essentialsAdProvider: null,
  entitlements: { maxAdChannels: null },
};

async function invoke(
  name: string,
  args: Record<string, unknown>,
  billing = essentials('META'),
) {
  const req = {
    body: { method: 'tools/call', params: { name, arguments: args } },
    context: { storeId },
  };
  const res = { locals: { billing } };
  const next = vi.fn();
  await requireMcpToolEntitlement(req as never, res as never, next);
  return { next, error: next.mock.calls[0]?.[0] as AppError | undefined };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MCP provider-neutral Product × Ads entitlement', () => {
  it.each(['META', 'TIKTOK', 'GOOGLE_ADS'] as const)(
    'delegates Essentials selected %s Product × Ads scope to the canonical unified scope',
    async (provider) => {
      const resolve = vi
        .spyOn(unifiedAdvertisingScopeService, 'resolve')
        .mockResolvedValue({ states: [], allSelectedAccounts: [], accounts: [] });

      const result = await invoke('stride_get_product_ads', { action: 'list', provider }, essentials(provider));

      expect(result.error).toBeUndefined();
      expect(resolve).toHaveBeenCalledWith({ storeId, provider });
    },
  );

  it('rejects Essentials provider A requesting provider B through the canonical scope error', async () => {
    vi.spyOn(unifiedAdvertisingScopeService, 'resolve').mockRejectedValue(
      new AppError('Channel not included', 403, 'PLAN_AD_CHANNEL_LIMIT'),
    );

    const result = await invoke(
      'stride_get_product_ads',
      { action: 'list', provider: 'TIKTOK' },
      essentials('META'),
    );

    expect(result.error).toMatchObject({ code: 'PLAN_AD_CHANNEL_LIMIT', statusCode: 403 });
  });

  it('preserves channel-selection-required behavior for provider=ALL/omitted Product × Ads', async () => {
    const resolve = vi.spyOn(unifiedAdvertisingScopeService, 'resolve').mockRejectedValue(
      new AppError('Choose a channel', 409, 'PLAN_CHANNEL_SELECTION_REQUIRED'),
    );

    const result = await invoke('stride_get_product_ads', { action: 'list' }, essentials(null));

    expect(resolve).toHaveBeenCalledWith({ storeId, provider: 'ALL' });
    expect(result.error).toMatchObject({
      code: 'PLAN_CHANNEL_SELECTION_REQUIRED',
      statusCode: 409,
    });
  });

  it('keeps Pro provider-neutral/multi-channel Product × Ads on provider=ALL', async () => {
    const resolve = vi
      .spyOn(unifiedAdvertisingScopeService, 'resolve')
      .mockResolvedValue({ states: [], allSelectedAccounts: [], accounts: [] });

    const result = await invoke('stride_get_product_ads', { action: 'list' }, pro);

    expect(result.error).toBeUndefined();
    expect(resolve).toHaveBeenCalledWith({ storeId, provider: 'ALL' });
  });

  it('uses the canonical billing provider guard for Google paid-media reads', async () => {
    const guard = vi
      .spyOn(billingService, 'requireAdProviderReadOnly')
      .mockResolvedValue({ effectivePlan: 'ESSENTIALS' } as never);

    const result = await invoke(
      'stride_get_paid_media',
      { provider: 'GOOGLE_ADS', action: 'overview' },
      essentials('GOOGLE_ADS'),
    );

    expect(result.error).toBeUndefined();
    expect(guard).toHaveBeenCalledWith(storeId, 'GOOGLE_ADS');
  });

  it('treats GROUP as paid-media search vocabulary and no longer treats stale AD_SET as generic public vocabulary', async () => {
    const groupResult = await invoke(
      'stride_search',
      { query: 'prospecting', entityTypes: ['GROUP'] },
      essentials('META'),
    );
    expect(groupResult.error).toMatchObject({ code: 'PLAN_AD_CHANNEL_LIMIT' });

    const staleResult = await invoke(
      'stride_search',
      { query: 'prospecting', entityTypes: ['AD_SET'] },
      essentials('META'),
    );
    expect(staleResult.error).toBeUndefined();

    const searchTool = MCP_TOOLS.find((tool) => tool.name === 'stride_search');
    const publicSearchSchema = JSON.stringify(searchTool?.inputSchema);
    expect(publicSearchSchema).toContain('GROUP');
    expect(publicSearchSchema).not.toContain('AD_SET');
  });

  it('publishes and forwards Product × Ads provider scope through the MCP tool contract', async () => {
    const productAdsTool = MCP_TOOLS.find((tool) => tool.name === 'stride_get_product_ads');
    const schema = JSON.stringify(productAdsTool?.inputSchema);
    expect(schema).toContain('META');
    expect(schema).toContain('TIKTOK');
    expect(schema).toContain('GOOGLE_ADS');

    const reads = {
      productAdsList: vi.fn().mockResolvedValue({ items: [] }),
      productAdsDetail: vi.fn().mockResolvedValue({ product: { id: productId } }),
    };
    const executor = new McpToolExecutor(reads as never, {} as never);

    await executor.call(storeId, 'stride_get_product_ads', {
      action: 'list',
      provider: 'TIKTOK',
      days: 14,
      page: 2,
      limit: 10,
    });
    expect(reads.productAdsList).toHaveBeenCalledWith(storeId, {
      action: 'list',
      provider: 'TIKTOK',
      days: 14,
      page: 2,
      limit: 10,
    });

    await executor.call(storeId, 'stride_get_product_ads', {
      action: 'detail',
      provider: 'GOOGLE_ADS',
      productId,
      days: 30,
    });
    expect(reads.productAdsDetail).toHaveBeenCalledWith(
      storeId,
      productId,
      30,
      'GOOGLE_ADS',
    );
  });
});
