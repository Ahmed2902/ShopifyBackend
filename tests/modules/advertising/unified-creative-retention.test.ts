import { describe, expect, it, vi } from 'vitest';
import { UnifiedPaidEntityService } from '../../../src/modules/advertising/unified-paid-entity.service.js';
import type { UnifiedAdvertisingScopeService } from '../../../src/modules/advertising/unified-advertising-scope.service.js';
import type {
  UnifiedPaidEntityRepository,
  UnifiedPaidEntityIdentity,
} from '../../../src/modules/advertising/unified-paid-entity.repository.js';
import type { IntelligenceContextReadRepository } from '../../../src/modules/intelligence/intelligence-context.read.repository.js';
import type { CreativeVideoRetentionService } from '../../../src/modules/analytics/creative-video-retention.service.js';

const meta: UnifiedPaidEntityIdentity = {
  id: 'creative-meta',
  providerEntityId: 'external-meta',
  kind: 'CREATIVE',
  name: 'Meta video',
  status: null,
  effectiveStatus: null,
  account: {
    id: 'canonical-meta',
    provider: 'META',
    providerEntityId: 'act_selected',
    name: 'Meta',
    currency: 'USD',
  },
  metadata: { videoId: 'video' },
};
const google: UnifiedPaidEntityIdentity = {
  ...meta,
  id: 'creative-google',
  account: {
    ...meta.account,
    id: 'canonical-google',
    provider: 'GOOGLE_ADS',
    providerEntityId: 'customer',
  },
};
function fixture(items = [meta, google]) {
  const forCreatives = vi
    .fn()
    .mockResolvedValue(new Map([[meta.id, { status: 'READY', current: { plays: 1000 } }]]));
  const service = new UnifiedPaidEntityService(
    {
      resolve: vi.fn().mockResolvedValue({ accounts: [], allSelectedAccounts: [], states: [] }),
    } as unknown as UnifiedAdvertisingScopeService,
    {
      page: vi.fn().mockResolvedValue({ items, total: items.length }),
      metrics: vi.fn().mockResolvedValue([]),
    } as unknown as UnifiedPaidEntityRepository,
    {
      getContext: vi.fn().mockResolvedValue({ ianaTimezone: 'UTC' }),
    } as unknown as IntelligenceContextReadRepository,
    { forCreatives } as unknown as CreativeVideoRetentionService,
  );
  return { service, forCreatives };
}
const query = {
  provider: 'ALL' as const,
  page: 1,
  limit: 50,
  days: 7,
  from: '2026-09-05',
  to: '2026-09-11',
};
describe('canonical creative retention capability', () => {
  it('batches only visible Meta creatives using their authorized provider accounts and exact window', async () => {
    const { service, forCreatives } = fixture();
    const response = await service.list('verified-store', 'CREATIVE', query);
    expect(forCreatives).toHaveBeenCalledTimes(1);
    const input = forCreatives.mock.calls[0]![0];
    expect(input).toMatchObject({
      storeId: 'verified-store',
      selectedAccountIds: ['act_selected'],
      creatives: [{ id: meta.id, videoId: 'video' }],
    });
    expect(input.windows.current.fromDate).toBe('2026-09-05');
    expect(input.windows.current.toDate).toBe('2026-09-11');
    expect(response.items[0]?.videoRetention).toMatchObject({ status: 'READY' });
    expect(response.items[1]?.videoRetention).toBeNull();
  });
  it('does not fabricate equivalent Google retention or perform a Meta read for Google-only pages', async () => {
    const { service, forCreatives } = fixture([google]);
    const response = await service.list('verified-store', 'CREATIVE', query);
    expect(forCreatives).not.toHaveBeenCalled();
    expect(response.items[0]?.videoRetention).toBeNull();
  });
  it('does not load creative diagnostics for other hierarchy levels', async () => {
    const { service, forCreatives } = fixture();
    const response = await service.list('verified-store', 'GROUP', query);
    expect(forCreatives).not.toHaveBeenCalled();
    expect(response.items[0]).not.toHaveProperty('videoRetention');
  });
});
