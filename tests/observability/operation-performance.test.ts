import { describe, expect, it, vi } from 'vitest';
import { logger } from '../../src/lib/logger.js';
import { profileBackgroundOperation } from '../../src/observability/operation-performance.js';
import { recordPrismaQuery } from '../../src/observability/request-performance.js';

describe('background operation performance', () => {
  it('records Prisma query count and union wall time for a provider sync', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);

    await profileBackgroundOperation(
      'provider_sync',
      { provider: 'SHOPIFY', mode: 'MANUAL', storeId: 'store-1', syncRunId: 'run-1' },
      async () => {
        recordPrismaQuery({
          model: 'Order',
          operation: 'findMany',
          durationMs: 25,
          startedAtMs: 0,
          endedAtMs: 25,
        });
        recordPrismaQuery({
          model: 'OrderLineItem',
          operation: 'findMany',
          durationMs: 20,
          startedAtMs: 10,
          endedAtMs: 30,
        });
        return 'ok';
      },
    );

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'background_operation_performance',
        operation: 'provider_sync',
        provider: 'SHOPIFY',
        mode: 'MANUAL',
        storeId: 'store-1',
        syncRunId: 'run-1',
        prismaQueryCount: 2,
        prismaQueryDurationMs: 45,
        prismaQueryWallTimeMs: 30,
        failed: false,
      }),
      'Background operation performance',
    );
    info.mockRestore();
  });

  it('logs failed operations before rethrowing them', async () => {
    const info = vi.spyOn(logger, 'info').mockImplementation(() => logger);

    await expect(
      profileBackgroundOperation(
        'provider_sync',
        { provider: 'SHOPIFY', mode: 'MANUAL' },
        async () => {
          throw new Error('sync failed');
        },
      ),
    ).rejects.toThrow('sync failed');

    expect(info).toHaveBeenCalledWith(
      expect.objectContaining({ failed: true, provider: 'SHOPIFY', mode: 'MANUAL' }),
      'Background operation performance',
    );
    info.mockRestore();
  });
});
