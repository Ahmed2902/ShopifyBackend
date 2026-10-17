import { beforeEach, expect, it, vi } from 'vitest';
const { tx, invalidate } = vi.hoisted(() => ({
  tx: {
    metaConnection: { updateMany: vi.fn() },
    tikTokConnection: { updateMany: vi.fn() },
    conversionDestination: { updateMany: vi.fn() },
  },
  invalidate: vi.fn(),
}));
vi.mock('../../../src/lib/prisma.js', () => ({
  prisma: { $transaction: async (work: (client: typeof tx) => Promise<unknown>) => work(tx) },
}));
vi.mock('../../../src/lib/store-decision-cache.js', () => ({
  invalidateStoreDecisionCaches: invalidate,
}));
import { disconnectAdvertisingProvider } from '../../../src/modules/integrations/provider-disconnect.service.js';
beforeEach(() => {
  vi.resetAllMocks();
});
it.each(['META', 'TIKTOK'] as const)(
  'erases %s authorization and every destination credential, scoped to this store',
  async (provider) => {
    await expect(disconnectAdvertisingProvider('store-a', provider)).resolves.toEqual({
      disconnected: true,
    });
    const own = provider === 'META' ? tx.metaConnection : tx.tikTokConnection;
    const other = provider === 'META' ? tx.tikTokConnection : tx.metaConnection;
    expect(own.updateMany).toHaveBeenCalledWith({
      where: { storeId: 'store-a' },
      data: expect.objectContaining({
        status: 'DISCONNECTED',
        accessTokenCiphertext: '',
        scopes: [],
        selectedCatalogIds: [],
      }),
    });
    if (provider === 'TIKTOK')
      expect(own.updateMany.mock.calls[0]?.[0].data).toMatchObject({
        refreshTokenCiphertext: null,
        refreshTokenExpiresAt: null,
        selectedAdvertiserIds: [],
      });
    expect(other.updateMany).not.toHaveBeenCalled();
    expect(tx.conversionDestination.updateMany).toHaveBeenCalledWith({
      where: { storeId: 'store-a', provider },
      data: { status: 'DISABLED', accessTokenCiphertext: null },
    });
    expect(invalidate).toHaveBeenCalledWith('store-a');
  },
);
it('does not report success or invalidate reads when the destination update fails', async () => {
  tx.conversionDestination.updateMany.mockRejectedValue(new Error('database unavailable'));
  await expect(disconnectAdvertisingProvider('store-a', 'META')).rejects.toThrow(
    'database unavailable',
  );
  expect(invalidate).not.toHaveBeenCalled();
});
