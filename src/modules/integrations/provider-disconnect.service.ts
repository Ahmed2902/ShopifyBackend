import { prisma } from '../../lib/prisma.js';
import { invalidateStoreDecisionCaches } from '../../lib/store-decision-cache.js';

/** Disconnect this store only. Never revoke a token that another store may also use. */
export async function disconnectAdvertisingProvider(storeId: string, provider: 'META' | 'TIKTOK') {
  await prisma.$transaction(async (tx) => {
    if (provider === 'META') {
      await tx.metaConnection.updateMany({
        where: { storeId },
        data: {
          status: 'DISCONNECTED',
          accessTokenCiphertext: '',
          tokenExpiresAt: null,
          metaUserId: null,
          metaBusinessId: null,
          scopes: [],
          selectedAdAccountIds: [],
          selectedCatalogIds: [],
        },
      });
    } else {
      await tx.tikTokConnection.updateMany({
        where: { storeId },
        data: {
          status: 'DISCONNECTED',
          accessTokenCiphertext: '',
          accessTokenExpiresAt: null,
          refreshTokenCiphertext: null,
          refreshTokenExpiresAt: null,
          openId: null,
          businessCenterId: null,
          scopes: [],
          selectedAdvertiserIds: [],
          selectedCatalogIds: [],
        },
      });
    }
    // Also erase manually supplied Events API tokens and stop queued dispatches. Historical
    // reports and delivery records remain; reconnecting requires deliberate pixel setup again.
    await tx.conversionDestination.updateMany({
      where: { storeId, provider },
      data: { status: 'DISABLED', accessTokenCiphertext: null },
    });
  });
  await invalidateStoreDecisionCaches(storeId);
  return { disconnected: true };
}
