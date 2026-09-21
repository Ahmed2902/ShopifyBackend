import type { Request, Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const analyticsCache = vi.hoisted(() => ({
  run: vi.fn(),
}));

vi.mock('../../../src/lib/store-decision-cache.js', () => ({
  analyticsWorkspaceCachedReads: analyticsCache,
}));

import { AnalyticsController } from '../../../src/modules/analytics/analytics.controller.js';

const storeId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function response() {
  const res = {
    status: vi.fn(),
    json: vi.fn(),
  };
  res.status.mockReturnValue(res);
  return res as unknown as Response;
}

function request(input: { query?: Record<string, string>; params?: Record<string, string> } = {}) {
  return {
    context: { storeId },
    query: input.query ?? {},
    params: input.params ?? {},
  } as unknown as Request;
}

function controller() {
  const workspace = {
    overview: vi.fn(),
    products: vi.fn().mockResolvedValue({ items: [{ id: 'product-1' }] }),
    product: vi.fn(),
    collections: vi.fn(),
    customers: vi.fn(),
    inventory: vi.fn(),
    advertising: vi.fn(),
    campaigns: vi.fn().mockResolvedValue({ items: [{ id: 'campaign-1' }] }),
    campaign: vi.fn(),
    adSets: vi.fn(),
    adSet: vi.fn(),
    ads: vi.fn(),
    ad: vi.fn(),
    creatives: vi.fn(),
    creative: vi.fn(),
  };
  const productAds = {
    list: vi.fn(),
    detail: vi.fn(),
  };
  return {
    workspace,
    productAds,
    value: new AnalyticsController(workspace as never, productAds as never),
  };
}

describe('AnalyticsController cached read surface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    analyticsCache.run.mockImplementation(
      async (_key: string, loader: () => Promise<unknown>) => loader(),
    );
  });

  it('caches paged product reads under the store generation', async () => {
    const { value, workspace } = controller();
    const res = response();

    await value.products(request({ query: { days: '14', page: '2', limit: '25' } }), res);

    expect(analyticsCache.run).toHaveBeenCalledTimes(1);
    expect(analyticsCache.run).toHaveBeenCalledWith(
      `${storeId}:products:::14:2:25`,
      expect.any(Function),
      { fresh: false, versionScope: storeId },
    );
    expect(workspace.products).toHaveBeenCalledWith(storeId, {
      days: 14,
      page: 2,
      limit: 25,
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('propagates explicit fresh reads to the generation-aware cache', async () => {
    const { value } = controller();
    const res = response();

    await value.campaigns(
      request({ query: { from: '2026-09-01', to: '2026-09-20', page: '1', limit: '10', fresh: 'true' } }),
      res,
    );

    expect(analyticsCache.run).toHaveBeenCalledWith(
      `${storeId}:campaigns:2026-09-01:2026-09-20:30:1:10`,
      expect.any(Function),
      { fresh: true, versionScope: storeId },
    );
  });

  it('includes entity identity in detail cache keys', async () => {
    const { value, workspace } = controller();
    const res = response();
    const campaignId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
    workspace.campaign.mockResolvedValue({ id: campaignId });

    await value.campaign(
      request({ params: { campaignId }, query: { days: '7' } }),
      res,
    );

    expect(analyticsCache.run).toHaveBeenCalledWith(
      `${storeId}:campaign:${campaignId}:::7::`,
      expect.any(Function),
      { fresh: false, versionScope: storeId },
    );
    expect(workspace.campaign).toHaveBeenCalledWith(storeId, campaignId, { days: 7 });
  });
});
