/// <reference types="node" />
import 'dotenv/config';

import { prisma } from '../src/lib/prisma.js';

const PREFIX = 'stride_fixture_';
const STRIDE_TRACKING = {
  campaign: 'stride_meta_campaign_id={{campaign.id}}',
  adSet: 'stride_meta_adset_id={{adset.id}}',
  ad: 'stride_meta_ad_id={{ad.id}}',
} as const;
const STRIDE_TRACKING_TEMPLATE = Object.values(STRIDE_TRACKING).join('&');

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

function stripStrideTracking(value: string | null) {
  return (value ?? '')
    .trim()
    .replace(/^\?/, '')
    .split('&')
    .map((part) => part.trim())
    .filter(Boolean)
    .filter((part) => !part.startsWith('stride_meta_campaign_id=') && !part.startsWith('stride_meta_adset_id=') && !part.startsWith('stride_meta_ad_id='))
    .join('&');
}

function withTracking(base: string, status: 'EXACT' | 'PARTIAL' | 'MISSING') {
  const parts = base ? [base] : [];
  if (status === 'EXACT') parts.push(STRIDE_TRACKING_TEMPLATE);
  if (status === 'PARTIAL') parts.push(STRIDE_TRACKING.campaign);
  return parts.join('&');
}

const storeId = required('META_FIXTURE_STORE_ID');
const metaAccountId = normalizeAccountId(required('META_FIXTURE_AD_ACCOUNT_ID'));
const confirmedAccountId = normalizeAccountId(required('META_FIXTURE_CONFIRM_AD_ACCOUNT_ID'));
const write = process.argv.includes('--write');

if (process.env.NODE_ENV === 'production') {
  throw new Error('Meta fixture tooling is disabled when NODE_ENV=production.');
}
if (metaAccountId !== confirmedAccountId) {
  throw new Error('META_FIXTURE_CONFIRM_AD_ACCOUNT_ID must exactly match META_FIXTURE_AD_ACCOUNT_ID');
}

const account = await prisma.metaAdAccount.findUnique({
  where: { storeId_metaAccountId: { storeId, metaAccountId } },
});
if (!account) throw new Error(`Selected Meta account ${metaAccountId} has no local MetaAdAccount row`);

const creatives = await prisma.metaCreative.findMany({
  where: {
    adAccountId: account.id,
    metaCreativeId: { startsWith: PREFIX },
  },
  orderBy: { metaCreativeId: 'asc' },
  select: {
    id: true,
    metaCreativeId: true,
    name: true,
    urlTags: true,
  },
});

if (creatives.length === 0) {
  throw new Error('No Stride Meta fixture creatives exist. Run dev:meta-fixtures:write first.');
}

const preview = creatives.map((creative, index) => {
  // Deliberately spread exact / partial / missing states across fixture creatives so the
  // tracking workflow can be exercised without pretending that every ad is configured.
  const status: 'EXACT' | 'PARTIAL' | 'MISSING' =
    index % 4 < 2 ? 'EXACT' : index % 4 === 2 ? 'PARTIAL' : 'MISSING';
  const automaticSupported = index % 5 !== 4;
  const existingMerchantTags = stripStrideTracking(creative.urlTags);
  return {
    ...creative,
    status,
    automaticSupported,
    nextUrlTags: withTracking(existingMerchantTags, status),
  };
});

console.log('Stride Meta tracking fixture coverage');
console.table({
  storeId,
  metaAccountId,
  creatives: preview.length,
  exact: preview.filter((item) => item.status === 'EXACT').length,
  partial: preview.filter((item) => item.status === 'PARTIAL').length,
  missing: preview.filter((item) => item.status === 'MISSING').length,
  automaticSupported: preview.filter((item) => item.automaticSupported).length,
  manualRequiredShape: preview.filter((item) => !item.automaticSupported).length,
});

if (!write) {
  console.log('\nPreview only. Re-run with --write to update fixture creative tracking states.');
  await prisma.$disconnect();
  process.exit(0);
}

for (const [index, creative] of preview.entries()) {
  await prisma.metaCreative.update({
    where: { id: creative.id },
    data: {
      urlTags: creative.nextUrlTags,
      // The tracking audit treats an existing object story as safe for cloning. Fixture-only
      // story IDs intentionally exercise both automatic-supported and manual-required UI states.
      objectStoryId: creative.automaticSupported ? `${PREFIX}story_${index + 1}` : null,
      objectStorySpec: null,
      assetFeedSpec: null,
    },
  });
}

console.log('Meta tracking fixture coverage applied. Existing UTM parameters were preserved.');
await prisma.$disconnect();
