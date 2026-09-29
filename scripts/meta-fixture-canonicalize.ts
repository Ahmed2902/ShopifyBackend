/// <reference types="node" />
import 'dotenv/config';

import { Prisma } from '../src/generated/prisma/client.js';
import { advertisingProjectionRepository } from '../src/modules/advertising/advertising-projection.repository.js';
import { advertisingWriteRepository } from '../src/modules/advertising/advertising-write.repository.js';
import { prisma } from '../src/lib/prisma.js';

const PREFIX = 'stride_fixture_';
const BATCH_SIZE = 100;

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function normalizeAccountId(value: string) {
  const raw = value.trim().replace(/^act_/, '');
  if (!/^\d+$/.test(raw)) throw new Error('META_FIXTURE_AD_ACCOUNT_ID must be numeric or act_<numeric>');
  return `act_${raw}`;
}

function number(value: unknown): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function json(value: Prisma.JsonValue | null): Prisma.InputJsonValue | typeof Prisma.DbNull {
  return value === null ? Prisma.DbNull : (value as Prisma.InputJsonValue);
}

function chunks<T>(values: T[], size = BATCH_SIZE): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

const storeId = required('META_FIXTURE_STORE_ID');
const metaAccountId = normalizeAccountId(required('META_FIXTURE_AD_ACCOUNT_ID'));
const confirmedAccountId = normalizeAccountId(required('META_FIXTURE_CONFIRM_AD_ACCOUNT_ID'));
const cleanupOnly = process.argv.includes('--cleanup');

if (process.env.NODE_ENV === 'production') {
  throw new Error('Meta fixture tooling is disabled when NODE_ENV=production.');
}
if (metaAccountId !== confirmedAccountId) {
  throw new Error('META_FIXTURE_CONFIRM_AD_ACCOUNT_ID must exactly match META_FIXTURE_AD_ACCOUNT_ID');
}

const account = await prisma.metaAdAccount.findUnique({
  where: { storeId_metaAccountId: { storeId, metaAccountId } },
  select: { id: true, name: true, currency: true },
});
if (!account) throw new Error(`Selected Meta account ${metaAccountId} has no local MetaAdAccount row`);

async function cleanupCanonical() {
  await prisma.$transaction(async (tx) => {
    await tx.advertisingProductMapping.deleteMany({
      where: { ad: { accountId: account.id, providerEntityId: { startsWith: PREFIX } } },
    });
    await tx.advertisingCollectionMapping.deleteMany({
      where: { ad: { accountId: account.id, providerEntityId: { startsWith: PREFIX } } },
    });
    await tx.advertisingDailyMetric.deleteMany({
      where: { accountId: account.id, metricKey: { startsWith: `META:${PREFIX}` } },
    });
    await tx.advertisingAd.deleteMany({
      where: { accountId: account.id, providerEntityId: { startsWith: PREFIX } },
    });
    await tx.advertisingCreative.deleteMany({
      where: { accountId: account.id, providerEntityId: { startsWith: PREFIX } },
    });
    await tx.advertisingGroup.deleteMany({
      where: { accountId: account.id, providerEntityId: { startsWith: PREFIX } },
    });
    await tx.advertisingCampaign.deleteMany({
      where: { accountId: account.id, providerEntityId: { startsWith: PREFIX } },
    });
  });
}

if (cleanupOnly) {
  await cleanupCanonical();
  console.log(`Removed canonical Stride Meta fixtures from ${metaAccountId}.`);
  await prisma.$disconnect();
  process.exit(0);
}

const [fixtureCampaigns, fixtureInsights, productMappings, collectionMappings] = await Promise.all([
  prisma.metaCampaign.count({
    where: { adAccountId: account.id, metaCampaignId: { startsWith: PREFIX }, deletedAt: null },
  }),
  prisma.metaInsightDaily.findMany({
    where: { adAccountId: account.id, insightKey: { startsWith: PREFIX } },
    select: {
      id: true,
      insightKey: true,
      campaignId: true,
      adSetId: true,
      adId: true,
      creativeIdSnapshot: true,
      level: true,
      date: true,
      accountCurrency: true,
      spend: true,
      impressions: true,
      reach: true,
      clicks: true,
      ctr: true,
      cpc: true,
      cpm: true,
      frequency: true,
      breakdownHash: true,
      breakdownJson: true,
      rawJson: true,
      syncedAt: true,
      actions: {
        where: { actionType: 'offsite_conversion.fb_pixel_purchase' },
        select: { kind: true, value: true },
      },
    },
    orderBy: [{ date: 'asc' }, { insightKey: 'asc' }],
  }),
  prisma.adProductMapping.findMany({
    where: { ad: { adAccountId: account.id, metaAdId: { startsWith: PREFIX } } },
  }),
  prisma.adCollectionMapping.findMany({
    where: { ad: { adAccountId: account.id, metaAdId: { startsWith: PREFIX } } },
  }),
]);

if (fixtureCampaigns === 0) {
  throw new Error('No legacy fixture campaigns exist. Run npm run dev:meta-fixtures:write first.');
}

// Rebuild just this fixture namespace so previously seeded native Meta fixtures become visible to
// the provider-neutral Marketing and Intelligence readers without touching real provider rows.
await cleanupCanonical();
await advertisingProjectionRepository.projectMetaHierarchy(account.id);

for (const batch of chunks(fixtureInsights)) {
  await prisma.$transaction(async (tx) => {
    for (const insight of batch) {
      const conversions = insight.actions
        .filter((action) => action.kind === 'ACTION')
        .reduce((sum, action) => sum + number(action.value), 0);
      const conversionValue = insight.actions
        .filter((action) => action.kind === 'ACTION_VALUE')
        .reduce((sum, action) => sum + number(action.value), 0);
      const spend = number(insight.spend);

      await advertisingWriteRepository.upsertDailyMetric(tx, {
        id: insight.id,
        metricKey: `META:${insight.insightKey}`,
        accountId: account.id,
        campaignId: insight.campaignId,
        groupId: insight.adSetId,
        adId: insight.adId,
        creativeIdSnapshot: insight.creativeIdSnapshot,
        level: insight.level === 'ADSET' ? 'GROUP' : insight.level,
        date: insight.date,
        currency: insight.accountCurrency,
        spend,
        impressions: insight.impressions,
        reach: insight.reach,
        clicks: insight.clicks,
        conversions,
        conversionValue,
        ctr: insight.ctr,
        cpc: insight.cpc,
        cpm: insight.cpm,
        frequency: insight.frequency,
        cpa: conversions > 0 ? spend / conversions : null,
        roas: spend > 0 ? conversionValue / spend : null,
        providerMetrics: { fixture: true, source: 'STRIDE_DB_FIXTURE' },
        breakdownHash: insight.breakdownHash,
        breakdownJson: insight.breakdownJson,
        rawJson: insight.rawJson,
        syncedAt: insight.syncedAt,
      });
    }
  }, { timeout: 20_000 });
}

for (const batch of chunks(productMappings)) {
  await prisma.$transaction(async (tx) => {
    for (const mapping of batch) {
      await tx.advertisingProductMapping.upsert({
        where: { id: mapping.id },
        create: {
          id: mapping.id,
          adId: mapping.metaAdId,
          productId: mapping.productId,
          variantId: mapping.variantId,
          granularity: mapping.granularity,
          optionSelector: json(mapping.optionSelector),
          source: mapping.source,
          confidence: mapping.confidence,
          evidenceJson: json(mapping.evidenceJson),
          landingUrl: mapping.landingUrl,
          providerProductId: mapping.providerProductId,
          providerProductGroupId: mapping.providerProductGroupId,
          isMerchantConfirmed: mapping.isMerchantConfirmed,
          validFrom: mapping.validFrom,
          validUntil: mapping.validUntil,
          createdAt: mapping.createdAt,
          updatedAt: mapping.updatedAt,
        },
        update: {
          adId: mapping.metaAdId,
          productId: mapping.productId,
          variantId: mapping.variantId,
          granularity: mapping.granularity,
          optionSelector: json(mapping.optionSelector),
          source: mapping.source,
          confidence: mapping.confidence,
          evidenceJson: json(mapping.evidenceJson),
          landingUrl: mapping.landingUrl,
          providerProductId: mapping.providerProductId,
          providerProductGroupId: mapping.providerProductGroupId,
          isMerchantConfirmed: mapping.isMerchantConfirmed,
          validFrom: mapping.validFrom,
          validUntil: mapping.validUntil,
        },
      });
    }
  }, { timeout: 20_000 });
}

for (const batch of chunks(collectionMappings)) {
  await prisma.$transaction(async (tx) => {
    for (const mapping of batch) {
      await tx.advertisingCollectionMapping.upsert({
        where: { id: mapping.id },
        create: {
          id: mapping.id,
          adId: mapping.metaAdId,
          collectionId: mapping.collectionId,
          source: mapping.source,
          confidence: mapping.confidence,
          evidenceJson: json(mapping.evidenceJson),
          landingUrl: mapping.landingUrl,
          isMerchantConfirmed: mapping.isMerchantConfirmed,
          validFrom: mapping.validFrom,
          validUntil: mapping.validUntil,
          createdAt: mapping.createdAt,
          updatedAt: mapping.updatedAt,
        },
        update: {
          adId: mapping.metaAdId,
          collectionId: mapping.collectionId,
          source: mapping.source,
          confidence: mapping.confidence,
          evidenceJson: json(mapping.evidenceJson),
          landingUrl: mapping.landingUrl,
          isMerchantConfirmed: mapping.isMerchantConfirmed,
          validFrom: mapping.validFrom,
          validUntil: mapping.validUntil,
        },
      });
    }
  }, { timeout: 20_000 });
}

console.log('Canonical Meta fixture projection complete');
console.table({
  account: `${account.name} (${metaAccountId})`,
  currency: account.currency,
  campaigns: fixtureCampaigns,
  dailyMetrics: fixtureInsights.length,
  productMappings: productMappings.length,
  collectionMappings: collectionMappings.length,
});

await prisma.$disconnect();
