/// <reference types="node" />
import 'dotenv/config';

import { prisma } from '../src/lib/prisma.js';

const PREFIX = 'stride_fixture_';
const DAYS = 60;

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

function dateOnly(value: Date) {
  return value.toISOString().slice(0, 10);
}

function addDays(value: Date, days: number) {
  const result = new Date(value);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
}

function startOfUtcToday() {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
}

function videoMetric(value: number) {
  return [{ action_type: 'video_view', value: String(Math.max(0, Math.round(value))) }];
}

const storeId = required('META_FIXTURE_STORE_ID');
const metaAccountId = normalizeAccountId(required('META_FIXTURE_AD_ACCOUNT_ID'));
const confirmedAccountId = normalizeAccountId(required('META_FIXTURE_CONFIRM_AD_ACCOUNT_ID'));
const write = process.argv.includes('--write');
const cleanupOnly = process.argv.includes('--cleanup');

if (process.env.NODE_ENV === 'production') {
  throw new Error('Meta fixture tooling is disabled when NODE_ENV=production. Run it explicitly from a local/dev process.');
}
if (metaAccountId !== confirmedAccountId) {
  throw new Error('META_FIXTURE_CONFIRM_AD_ACCOUNT_ID must exactly match META_FIXTURE_AD_ACCOUNT_ID');
}
if (write && cleanupOnly) throw new Error('Choose either --write or --cleanup, not both');

const connection = await prisma.metaConnection.findUnique({
  where: { storeId },
});
if (!connection) throw new Error(`No Meta connection exists for store ${storeId}`);
if (connection.status !== 'ACTIVE') throw new Error(`Meta connection is ${connection.status}, expected ACTIVE`);
if (!connection.selectedAdAccountIds.includes(metaAccountId)) {
  throw new Error(`${metaAccountId} is not selected on the store Meta connection`);
}

const account = await prisma.metaAdAccount.findUnique({
  where: { storeId_metaAccountId: { storeId, metaAccountId } },
});
if (!account) throw new Error(`Selected Meta account ${metaAccountId} has no local MetaAdAccount row`);

const store = await prisma.store.findUnique({ where: { id: storeId } });
if (!store) throw new Error(`Store ${storeId} does not exist`);

const products = await prisma.product.findMany({
  where: { storeId, deletedAt: null, status: 'ACTIVE' },
  orderBy: [{ totalInventory: 'asc' }, { title: 'asc' }],
  take: 12,
});
if (products.length < 4) throw new Error('At least four active Shopify products are required for meaningful Meta fixtures');

const collections = await prisma.collection.findMany({
  where: { storeId, deletedAt: null },
  orderBy: { title: 'asc' },
  take: 4,
});

async function cleanup() {
  const fixtureAds = await prisma.metaAd.findMany({
    where: { adAccountId: account.id, metaAdId: { startsWith: PREFIX } },
    select: { id: true },
  });
  const adIds = fixtureAds.map((item) => item.id);
  const fixtureInsights = await prisma.metaInsightDaily.findMany({
    where: { adAccountId: account.id, insightKey: { startsWith: PREFIX } },
    select: { id: true },
  });
  const insightIds = fixtureInsights.map((item) => item.id);

  await prisma.$transaction(async (tx) => {
    if (insightIds.length) {
      await tx.metaInsightAction.deleteMany({ where: { insightId: { in: insightIds } } });
    }
    await tx.metaInsightDaily.deleteMany({
      where: { adAccountId: account.id, insightKey: { startsWith: PREFIX } },
    });
    if (adIds.length) {
      await tx.adProductMapping.deleteMany({ where: { metaAdId: { in: adIds } } });
      await tx.adCollectionMapping.deleteMany({ where: { metaAdId: { in: adIds } } });
    }
    await tx.metaAd.deleteMany({
      where: { adAccountId: account.id, metaAdId: { startsWith: PREFIX } },
    });
    await tx.metaCreative.deleteMany({
      where: { adAccountId: account.id, metaCreativeId: { startsWith: PREFIX } },
    });
    await tx.metaAdSet.deleteMany({
      where: { adAccountId: account.id, metaAdSetId: { startsWith: PREFIX } },
    });
    await tx.metaCampaign.deleteMany({
      where: { adAccountId: account.id, metaCampaignId: { startsWith: PREFIX } },
    });
  });
}

if (cleanupOnly) {
  await cleanup();
  console.log(`Removed Stride Meta fixtures from ${metaAccountId} for store ${storeId}.`);
  await prisma.$disconnect();
  process.exit(0);
}

const existing = await prisma.metaCampaign.count({
  where: { adAccountId: account.id, metaCampaignId: { startsWith: PREFIX } },
});

console.log('Stride Meta fixture target');
console.table({
  store: `${store.name} (${store.id})`,
  shopifyDomain: store.myshopifyDomain,
  storeCurrency: store.currencyCode,
  metaAccount: `${account.name} (${metaAccountId})`,
  metaCurrency: account.currency,
  products: products.length,
  collections: collections.length,
  existingFixtureCampaigns: existing,
});

if (!write) {
  console.log('\nPreview only. Re-run with --write after verifying the target above.');
  console.log('The writer creates 4 campaigns, 8 ad sets, 16 ads/creatives and 60 days of ad-level Insights.');
  await prisma.$disconnect();
  process.exit(0);
}

await cleanup();

const scenarios = [
  {
    key: 'healthy_growth',
    name: 'Healthy Growth | Scale Candidate',
    objective: 'OUTCOME_SALES',
    video: false,
    targetScope: 'PRODUCT' as const,
    previous: { spend: 32, impressions: 3200, reach: 2400, clicks: 128, purchases: 6, value: 480 },
    current: { spend: 38, impressions: 3500, reach: 2600, clicks: 165, purchases: 8, value: 680 },
  },
  {
    key: 'efficiency_decline',
    name: 'Efficiency Alert | Spend Up ROAS Down',
    objective: 'OUTCOME_SALES',
    video: false,
    targetScope: 'PRODUCT' as const,
    previous: { spend: 30, impressions: 3000, reach: 2250, clicks: 120, purchases: 6, value: 450 },
    current: { spend: 48, impressions: 3700, reach: 2100, clicks: 78, purchases: 2, value: 110 },
  },
  {
    key: 'creative_fatigue',
    name: 'Creative Fatigue | Video Retention Drop',
    objective: 'OUTCOME_SALES',
    video: true,
    targetScope: 'PRODUCT' as const,
    previous: { spend: 24, impressions: 2800, reach: 2050, clicks: 112, purchases: 5, value: 360 },
    current: { spend: 31, impressions: 3300, reach: 1200, clicks: 58, purchases: 2, value: 125 },
  },
  {
    key: 'shared_inventory',
    name: 'Shared Exposure | Inventory Pressure',
    objective: 'OUTCOME_SALES',
    video: false,
    targetScope: 'MULTI_PRODUCT' as const,
    previous: { spend: 40, impressions: 3800, reach: 2800, clicks: 145, purchases: 7, value: 560 },
    current: { spend: 56, impressions: 4500, reach: 3050, clicks: 165, purchases: 9, value: 720 },
  },
] as const;

type MetricShape = (typeof scenarios)[number]['previous'];

function scaled(input: MetricShape, factor: number) {
  return {
    spend: input.spend * factor,
    impressions: Math.round(input.impressions * factor),
    reach: Math.round(input.reach * factor),
    clicks: Math.round(input.clicks * factor),
    purchases: input.purchases * factor,
    value: input.value * factor,
  };
}

const today = startOfUtcToday();
const firstDay = addDays(today, -(DAYS - 1));
let campaignCount = 0;
let adSetCount = 0;
let adCount = 0;
let insightCount = 0;
let actionCount = 0;
let mappingCount = 0;

for (const [campaignIndex, scenario] of scenarios.entries()) {
  const campaign = await prisma.metaCampaign.create({
    data: {
      adAccountId: account.id,
      metaCampaignId: `${PREFIX}campaign_${scenario.key}`,
      name: `[Fixture] ${scenario.name}`,
      status: 'ACTIVE',
      configuredStatus: 'ACTIVE',
      effectiveStatus: 'ACTIVE',
      objective: scenario.objective,
      buyingType: 'AUCTION',
      bidStrategy: 'LOWEST_COST_WITHOUT_CAP',
      dailyBudgetMinor: BigInt(Math.round(scenario.current.spend * 100 * 4)),
      startTime: firstDay,
      metaCreatedAt: addDays(firstDay, -10),
      metaUpdatedAt: today,
      rawJson: { fixture: true, source: 'STRIDE_DB_FIXTURE', scenario: scenario.key },
    },
  });
  campaignCount += 1;

  for (let adSetIndex = 0; adSetIndex < 2; adSetIndex += 1) {
    const adSet = await prisma.metaAdSet.create({
      data: {
        adAccountId: account.id,
        campaignId: campaign.id,
        metaAdSetId: `${PREFIX}adset_${scenario.key}_${adSetIndex + 1}`,
        name: `[Fixture] ${scenario.name} | Audience ${adSetIndex + 1}`,
        status: 'ACTIVE',
        configuredStatus: 'ACTIVE',
        effectiveStatus: 'ACTIVE',
        optimizationGoal: 'OFFSITE_CONVERSIONS',
        billingEvent: 'IMPRESSIONS',
        destinationType: 'WEBSITE',
        bidStrategy: 'LOWEST_COST_WITHOUT_CAP',
        targeting: {
          geo_locations: { countries: adSetIndex === 0 ? ['US'] : ['GB'] },
          age_min: 21,
          age_max: 55,
          publisher_platforms: ['facebook', 'instagram'],
        },
        attributionSpec: [{ event_type: 'CLICK_THROUGH', window_days: 7 }, { event_type: 'VIEW_THROUGH', window_days: 1 }],
        startTime: firstDay,
        metaCreatedAt: addDays(firstDay, -10),
        metaUpdatedAt: today,
        rawJson: { fixture: true, source: 'STRIDE_DB_FIXTURE', scenario: scenario.key },
      },
    });
    adSetCount += 1;

    for (let adIndex = 0; adIndex < 2; adIndex += 1) {
      const ordinal = campaignIndex * 4 + adSetIndex * 2 + adIndex;
      const product = products[ordinal % products.length]!;
      const secondProduct = products[(ordinal + 1) % products.length]!;
      const intentionallyUnmapped = scenario.key === 'shared_inventory' && adSetIndex === 1 && adIndex === 1;
      const handle = product.handle ?? product.title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
      const landingUrl = `https://${store.myshopifyDomain}/products/${handle}`;

      const creative = await prisma.metaCreative.create({
        data: {
          adAccountId: account.id,
          metaCreativeId: `${PREFIX}creative_${scenario.key}_${adSetIndex + 1}_${adIndex + 1}`,
          name: `[Fixture] ${scenario.name} Creative ${adSetIndex + 1}.${adIndex + 1}`,
          title: scenario.video ? `Watch ${product.title} in action` : `Shop ${product.title}`,
          body: scenario.video ? 'Realistic fixture video creative for Stride retention diagnostics.' : 'Realistic fixture creative for Stride paid-media diagnostics.',
          callToActionType: 'SHOP_NOW',
          callToAction: { type: 'SHOP_NOW', value: { link: landingUrl } },
          linkUrl: landingUrl,
          objectUrl: landingUrl,
          videoId: scenario.video ? `${PREFIX}video_${scenario.key}_${adSetIndex + 1}_${adIndex + 1}` : null,
          imageUrl: scenario.video ? null : `https://images.example.invalid/${PREFIX}${ordinal}.jpg`,
          thumbnailUrl: `https://images.example.invalid/${PREFIX}${ordinal}_thumb.jpg`,
          resolvedDestinationUrls: [landingUrl],
          urlTags: `utm_source=facebook&utm_medium=paid_social&utm_campaign=${PREFIX}${scenario.key}&utm_content=${adSetIndex + 1}_${adIndex + 1}`,
          metaCreatedAt: addDays(firstDay, -10),
          metaUpdatedAt: addDays(firstDay, -3),
          rawJson: { fixture: true, source: 'STRIDE_DB_FIXTURE', scenario: scenario.key },
        },
      });

      const ad = await prisma.metaAd.create({
        data: {
          adAccountId: account.id,
          campaignId: campaign.id,
          adSetId: adSet.id,
          creativeId: creative.id,
          metaAdId: `${PREFIX}ad_${scenario.key}_${adSetIndex + 1}_${adIndex + 1}`,
          name: `[Fixture] ${scenario.name} Ad ${adSetIndex + 1}.${adIndex + 1}`,
          configuredStatus: 'ACTIVE',
          effectiveStatus: 'ACTIVE',
          conversionDomain: store.myshopifyDomain,
          targetScope: intentionallyUnmapped ? 'UNKNOWN' : scenario.targetScope,
          targetScopeConfidence: intentionallyUnmapped ? 0.25 : scenario.targetScope === 'MULTI_PRODUCT' ? 0.9 : 0.97,
          targetScopeEvidence: intentionallyUnmapped
            ? { source: 'FIXTURE', reason: 'intentionally_unmapped_for_coverage_testing' }
            : { source: 'LANDING_URL_AND_CREATIVE', landingUrl },
          placement: { publisher_platforms: ['facebook', 'instagram'] },
          trackingSpec: [{ action_type: ['offsite_conversion'], fb_pixel: ['fixture-pixel'] }],
          recommendations: scenario.key === 'efficiency_decline' ? [{ code: 'FIXTURE_REVIEW_PERFORMANCE' }] : [],
          metaCreatedAt: addDays(firstDay, -10),
          metaUpdatedAt: today,
          rawJson: { fixture: true, source: 'STRIDE_DB_FIXTURE', scenario: scenario.key },
        },
      });
      adCount += 1;

      if (!intentionallyUnmapped) {
        await prisma.adProductMapping.create({
          data: {
            metaAdId: ad.id,
            productId: product.id,
            granularity: 'PRODUCT',
            source: 'URL',
            confidence: scenario.targetScope === 'MULTI_PRODUCT' ? 0.86 : 0.97,
            evidenceJson: { fixture: true, source: 'LANDING_URL', landingUrl },
            landingUrl,
            isMerchantConfirmed: false,
          },
        });
        mappingCount += 1;

        if (scenario.targetScope === 'MULTI_PRODUCT') {
          await prisma.adProductMapping.create({
            data: {
              metaAdId: ad.id,
              productId: secondProduct.id,
              granularity: 'PRODUCT',
              source: 'CREATIVE_PRODUCT_DATA',
              confidence: 0.82,
              evidenceJson: { fixture: true, source: 'SHARED_CREATIVE_PRODUCT_DATA' },
              isMerchantConfirmed: false,
            },
          });
          mappingCount += 1;
        }

        if (collections.length && campaignIndex === 3 && adSetIndex === 0) {
          const collection = collections[adIndex % collections.length]!;
          await prisma.adCollectionMapping.create({
            data: {
              metaAdId: ad.id,
              collectionId: collection.id,
              source: 'LANDING_PAGE',
              confidence: 0.84,
              evidenceJson: { fixture: true, source: 'COLLECTION_LANDING_EVIDENCE' },
              landingUrl: `https://${store.myshopifyDomain}/collections/${collection.handle ?? 'all'}`,
              isMerchantConfirmed: false,
            },
          });
          mappingCount += 1;
        }
      }

      for (let dayIndex = 0; dayIndex < DAYS; dayIndex += 1) {
        const date = addDays(firstDay, dayIndex);
        const current30 = dayIndex >= 30;
        const current7 = dayIndex >= 53;
        const comparison7 = dayIndex >= 46 && dayIndex < 53;
        const base = current30 ? scenario.current : scenario.previous;
        const weekdayFactor = [0.88, 0.95, 1.02, 1.08, 1.12, 1.05, 0.9][date.getUTCDay()] ?? 1;
        const adFactor = 0.42 + adIndex * 0.08 + adSetIndex * 0.04;
        const periodFactor = current7 ? 1.08 : comparison7 ? 0.98 : 1;
        const metrics = scaled(base, weekdayFactor * adFactor * periodFactor);
        const frequency = metrics.reach > 0 ? metrics.impressions / metrics.reach : 0;
        const ctr = metrics.impressions > 0 ? metrics.clicks / metrics.impressions : 0;
        const cpc = metrics.clicks > 0 ? metrics.spend / metrics.clicks : 0;
        const cpm = metrics.impressions > 0 ? (metrics.spend / metrics.impressions) * 1000 : 0;
        const purchases = Math.max(0, Number(metrics.purchases.toFixed(4)));
        const purchaseValue = Math.max(0, Number(metrics.value.toFixed(4)));
        const roas = metrics.spend > 0 ? purchaseValue / metrics.spend : 0;

        const videoMetrics = scenario.video
          ? (() => {
              const plays = Math.round(metrics.impressions * (current30 ? 0.55 : 0.62));
              const ratios = current30
                ? { p25: 0.63, p50: 0.37, p75: 0.18, p95: 0.11, p100: 0.08, thru: 0.22, sec30: 0.1, avg: 7 }
                : { p25: 0.82, p50: 0.64, p75: 0.45, p95: 0.36, p100: 0.31, thru: 0.48, sec30: 0.28, avg: 12 };
              return {
                plays: videoMetric(plays),
                p25: videoMetric(plays * ratios.p25),
                p50: videoMetric(plays * ratios.p50),
                p75: videoMetric(plays * ratios.p75),
                p95: videoMetric(plays * ratios.p95),
                p100: videoMetric(plays * ratios.p100),
                thruplay: videoMetric(plays * ratios.thru),
                sec30: videoMetric(plays * ratios.sec30),
                avgTime: videoMetric(ratios.avg),
              };
            })()
          : null;

        const insightKey = `${PREFIX}${account.metaAccountId}_${scenario.key}_${adSetIndex + 1}_${adIndex + 1}_${dateOnly(date)}`;
        const insight = await prisma.metaInsightDaily.create({
          data: {
            insightKey,
            adAccountId: account.id,
            campaignId: campaign.id,
            adSetId: adSet.id,
            adId: ad.id,
            creativeIdSnapshot: creative.id,
            creativeSnapshotTracked: true,
            level: 'AD',
            date,
            accountCurrency: account.currency,
            spend: Number(metrics.spend.toFixed(6)),
            socialSpend: Number((metrics.spend * 0.08).toFixed(6)),
            impressions: BigInt(metrics.impressions),
            reach: BigInt(Math.min(metrics.reach, metrics.impressions)),
            clicks: BigInt(metrics.clicks),
            uniqueClicks: BigInt(Math.round(metrics.clicks * 0.88)),
            outboundClicks: BigInt(Math.round(metrics.clicks * 0.76)),
            uniqueOutboundClicks: BigInt(Math.round(metrics.clicks * 0.68)),
            inlineLinkClicks: BigInt(Math.round(metrics.clicks * 0.81)),
            inlinePostEngagement: BigInt(Math.round(metrics.clicks * 1.3)),
            cpc: Number(cpc.toFixed(8)),
            cpm: Number(cpm.toFixed(8)),
            ctr: Number(ctr.toFixed(8)),
            frequency: Number(frequency.toFixed(8)),
            objective: scenario.objective,
            optimizationGoal: 'OFFSITE_CONVERSIONS',
            attributionSetting: '7d_click_1d_view',
            actionReportTime: 'impression',
            conversions: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: String(purchases) }],
            conversionValues: [{ action_type: 'offsite_conversion.fb_pixel_purchase', value: String(purchaseValue) }],
            videoMetrics,
            rawJson: { fixture: true, source: 'STRIDE_DB_FIXTURE', scenario: scenario.key },
          },
        });
        insightCount += 1;

        const actionRows = [
          { suffix: 'purchase', kind: 'ACTION' as const, value: purchases },
          { suffix: 'purchase_value', kind: 'ACTION_VALUE' as const, value: purchaseValue },
          { suffix: 'website_roas', kind: 'WEBSITE_PURCHASE_ROAS' as const, value: roas },
        ];
        for (const action of actionRows) {
          await prisma.metaInsightAction.create({
            data: {
              actionKey: `${insightKey}_${action.suffix}`,
              insightId: insight.id,
              kind: action.kind,
              actionType: 'offsite_conversion.fb_pixel_purchase',
              actionDestination: 'website',
              value: Number(action.value.toFixed(10)),
              attributionWindow: '7d_click_1d_view',
              metadata: { fixture: true },
            },
          });
          actionCount += 1;
        }
      }
    }
  }
}

console.log('\nFixture write complete');
console.table({
  campaigns: campaignCount,
  adSets: adSetCount,
  adsAndCreatives: adCount,
  dailyInsights: insightCount,
  insightActions: actionCount,
  mappings: mappingCount,
});
console.log(`All generated Meta external IDs/insight keys use prefix ${PREFIX}.`);
console.log('Run the same command with --cleanup to remove only these fixture rows.');

await prisma.$disconnect();
