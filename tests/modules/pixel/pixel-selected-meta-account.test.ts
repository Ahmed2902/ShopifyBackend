import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { prisma } from '../../../src/lib/prisma.js';
import { MetaRepository } from '../../../src/modules/meta/meta.repository.js';
import { PixelJourneyRepository } from '../../../src/modules/pixel/journey/pixel-journey.repository.js';

const describeDatabase = process.env.RUN_DB_TESTS === 'true' ? describe : describe.skip;
const stores: string[] = [];

async function createStore() {
  const suffix = randomUUID();
  const store = await prisma.store.create({
    data: {
      shopifyShopId: `gid://shopify/Shop/${suffix}`,
      name: 'Pixel selected Meta account store',
      myshopifyDomain: `pixel-meta-scope-${suffix}.myshopify.com`,
      currencyCode: 'USD',
      ianaTimezone: 'UTC',
    },
  });
  stores.push(store.id);
  return store;
}

async function cleanupStore(storeId: string) {
  await prisma.storefrontSessionTouch.deleteMany({ where: { session: { storeId } } });
  await prisma.storefrontSessionRepair.deleteMany({ where: { storeId } });
  await prisma.storefrontSession.deleteMany({ where: { storeId } });
  await prisma.metaAd.deleteMany({ where: { adAccount: { storeId } } });
  await prisma.metaAdSet.deleteMany({ where: { adAccount: { storeId } } });
  await prisma.metaCampaign.deleteMany({ where: { adAccount: { storeId } } });
  await prisma.metaCreative.deleteMany({ where: { adAccount: { storeId } } });
  await prisma.metaAdAccount.deleteMany({ where: { storeId } });
  await prisma.metaConnection.deleteMany({ where: { storeId } });
  await prisma.store.delete({ where: { id: storeId } });
}

afterEach(async () => {
  for (const storeId of stores.splice(0)) {
    await cleanupStore(storeId);
  }
});

describeDatabase('Pixel selected Meta account scope', () => {
  it('resolves only selected accounts and repairs retained touches when selection changes', async () => {
    const store = await createStore();
    const connection = await prisma.metaConnection.create({
      data: {
        storeId: store.id,
        accessTokenCiphertext: 'test',
        apiVersion: 'v26.0',
        selectedAdAccountIds: ['act_selected'],
      },
    });
    const selectedAccount = await prisma.metaAdAccount.create({
      data: {
        storeId: store.id,
        metaConnectionId: connection.id,
        metaAccountId: 'act_selected',
        name: 'Selected',
        currency: 'USD',
      },
    });
    const otherAccount = await prisma.metaAdAccount.create({
      data: {
        storeId: store.id,
        metaConnectionId: connection.id,
        metaAccountId: 'act_other',
        name: 'Other',
        currency: 'USD',
      },
    });
    const selectedCampaign = await prisma.metaCampaign.create({
      data: {
        adAccountId: selectedAccount.id,
        metaCampaignId: 'campaign_selected',
        name: 'Selected campaign',
      },
    });
    await prisma.metaCampaign.create({
      data: {
        adAccountId: otherAccount.id,
        metaCampaignId: 'campaign_other',
        name: 'Other campaign',
      },
    });

    const journeyRepository = new PixelJourneyRepository();
    const before = await journeyRepository.resolveMetaHierarchy(store.id, {
      campaignIds: ['campaign_selected', 'campaign_other'],
      adSetIds: [],
      adIds: [],
    });
    expect(before.campaigns.map((row) => row.metaCampaignId)).toEqual(['campaign_selected']);

    const now = new Date();
    const session = await prisma.storefrontSession.create({
      data: {
        storeId: store.id,
        browserSessionId: randomUUID(),
        startedAt: now,
        endedAt: now,
        lastSourceReceivedAt: now,
        eventCount: 1,
        retentionExpiresAt: new Date(now.getTime() + 86_400_000),
      },
    });
    await prisma.storefrontSessionTouch.create({
      data: {
        sessionId: session.id,
        ordinal: 1,
        eventAt: now,
        source: 'META',
        metaCampaignExternalId: 'campaign_selected',
        metaCampaignId: selectedCampaign.id,
        metaResolutionStatus: 'PARTIAL',
      },
    });

    await new MetaRepository().configureAssets({
      connectionId: connection.id,
      storeId: store.id,
      metaBusinessId: null,
      adAccounts: [
        {
          id: 'act_other',
          accountId: 'other',
          name: 'Other',
          accountStatus: 1,
          currency: 'USD',
          timezoneName: 'UTC',
          timezoneId: 1,
          timezoneOffsetHoursUtc: 0,
          amountSpentMinor: null,
          balanceMinor: null,
          spendCapMinor: null,
          business: null,
          raw: {},
        },
      ],
    });

    expect(await prisma.storefrontSessionRepair.findUnique({
      where: {
        storeId_browserSessionId: {
          storeId: store.id,
          browserSessionId: session.browserSessionId,
        },
      },
    })).not.toBeNull();

    const after = await journeyRepository.resolveMetaHierarchy(store.id, {
      campaignIds: ['campaign_selected', 'campaign_other'],
      adSetIds: [],
      adIds: [],
    });
    expect(after.campaigns.map((row) => row.metaCampaignId)).toEqual(['campaign_other']);
  });
});