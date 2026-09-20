import { afterEach, describe, expect, it, vi } from 'vitest';
import type { IntegrationService } from '../../../src/modules/integrations/integration.service.js';
import { ShopifyService } from '../../../src/modules/shopify/shopify.service.js';
import type { ShopifyRepository } from '../../../src/modules/shopify/shopify.repository.js';

const syncRunId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const storeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const leaseToken = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

describe('ShopifyService manual sync worker lease', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renews the claimed SyncRun lease with its owner token and clears the heartbeat afterward', async () => {
    const integrations = {
      listClaimableShopifySyncRunIds: vi.fn().mockResolvedValue([syncRunId]),
      claimShopifySyncRun: vi.fn().mockResolvedValue({
        id: syncRunId,
        leaseToken,
        shopifyConnection: { storeId },
      }),
      renewShopifySyncRunLease: vi.fn().mockResolvedValue({ count: 1 }),
    } as unknown as IntegrationService;

    const heartbeat = { unref: vi.fn() } as unknown as NodeJS.Timeout;
    let heartbeatCallback: (() => void) | undefined;
    const interval = vi.spyOn(globalThis, 'setInterval').mockImplementation((callback) => {
      heartbeatCallback = callback as () => void;
      return heartbeat;
    });
    const clear = vi.spyOn(globalThis, 'clearInterval').mockImplementation(() => undefined);

    const service = new ShopifyService({} as ShopifyRepository, integrations);
    const execute = vi
      .spyOn(
        service as unknown as {
          executeCatalogAndInventorySync(
            store: string,
            run: string,
            token?: string,
            lost?: () => boolean,
          ): Promise<unknown>;
        },
        'executeCatalogAndInventorySync',
      )
      .mockResolvedValue({});

    const processing = service.processManualSyncQueue(1);
    await vi.waitFor(() => expect(interval).toHaveBeenCalledTimes(1));
    heartbeatCallback?.();
    await vi.waitFor(() =>
      expect(integrations.renewShopifySyncRunLease).toHaveBeenCalledWith(syncRunId, leaseToken),
    );

    await expect(processing).resolves.toEqual({ claimed: 1, succeeded: 1, failed: 0 });
    expect(execute).toHaveBeenCalledWith(storeId, syncRunId, leaseToken, expect.any(Function));
    expect(heartbeat.unref).toHaveBeenCalledTimes(1);
    expect(clear).toHaveBeenCalledWith(heartbeat);
  });
});
