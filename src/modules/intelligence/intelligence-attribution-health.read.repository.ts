import { prisma } from '../../lib/prisma.js';

export interface AttributionHealthEvidence {
  quality: 'READY' | 'DEGRADED' | 'NOT_READY';
  metaTouchedSessions: number;
  metaLinkedPurchaseSessions: number;
}

/**
 * Store-level first-party Meta attribution support for provider-vs-journey diagnostics.
 * This intentionally reads the SOURCE rollup so a purchase journey is counted once for
 * the Meta source rather than once per touched Meta ad.
 */
export class IntelligenceAttributionHealthReadRepository {
  async getEvidence(input: {
    storeId: string;
    from: Date;
    to: Date;
  }): Promise<AttributionHealthEvidence> {
    const [rollup, aggregate] = await Promise.all([
      prisma.storefrontAttributionRollupState.findUnique({
        where: { storeId: input.storeId },
        select: { lastRolledUpAt: true, lastError: true },
      }),
      prisma.storefrontAttributionDaily.aggregate({
        where: {
          storeId: input.storeId,
          dimension: 'SOURCE',
          source: 'META',
          bucketDate: { gte: input.from, lte: input.to },
        },
        _sum: {
          touchedSessionCount: true,
          linkedPurchaseSessionCount: true,
        },
      }),
    ]);

    const quality = !rollup?.lastRolledUpAt
      ? 'NOT_READY'
      : rollup.lastError
        ? 'DEGRADED'
        : 'READY';

    return {
      quality,
      metaTouchedSessions: aggregate._sum.touchedSessionCount ?? 0,
      metaLinkedPurchaseSessions: aggregate._sum.linkedPurchaseSessionCount ?? 0,
    };
  }
}
