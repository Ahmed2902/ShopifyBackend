const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

if (process.env.NODE_ENV === 'production') {
  throw new Error('Meta sandbox seeding is disabled when NODE_ENV=production');
}

const token = required('META_SANDBOX_TOKEN');
const rawAccountId = required('META_SANDBOX_AD_ACCOUNT_ID');
const pageId = required('META_SANDBOX_PAGE_ID');
const apiVersion = process.env.META_SANDBOX_API_VERSION?.trim() || 'v26.0';
const destinationUrl =
  process.env.META_SANDBOX_DESTINATION_URL?.trim() || 'https://example.com';
const configuredImageHash = process.env.META_SANDBOX_IMAGE_HASH?.trim() || null;
const imageUrl = process.env.META_SANDBOX_IMAGE_URL?.trim() || null;
const dryRun = process.argv.includes('--dry-run');
const asJson = process.argv.includes('--json');
const accountId = rawAccountId.replace(/^act_/, '');
const accountPath = `act_${accountId}`;
const graphOrigin = `https://graph.facebook.com/${apiVersion}`;

if (!/^\d+$/.test(accountId)) {
  throw new Error('META_SANDBOX_AD_ACCOUNT_ID must be a numeric ID or act_<numeric ID>');
}
if (!/^\d+$/.test(pageId)) {
  throw new Error('META_SANDBOX_PAGE_ID must be numeric');
}
if (!/^v\d+\.\d+$/.test(apiVersion)) {
  throw new Error('META_SANDBOX_API_VERSION must look like v26.0');
}
new URL(destinationUrl);
if (imageUrl) new URL(imageUrl);

type GraphError = {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  fbtrace_id?: string;
};

type GraphEnvelope<T> = {
  data?: T[];
  id?: string;
  images?: Record<string, { hash?: string; url?: string }>;
  error?: GraphError;
};

type NamedEntity = { id: string; name: string };
type Campaign = NamedEntity & { status?: string };
type AdSet = NamedEntity & { campaign_id?: string; status?: string };
type Creative = NamedEntity;
type Ad = NamedEntity & { adset_id?: string; status?: string };

type TrackingMode = 'MISSING' | 'PARTIAL' | 'EXACT';

type CreatedManifest = {
  account: {
    id: string;
    name: string | null;
    currency: string | null;
    timezoneName: string | null;
  };
  imageHash: string | null;
  campaigns: Array<{
    id: string;
    name: string;
    adSets: Array<{
      id: string;
      name: string;
      ads: Array<{
        id: string;
        name: string;
        creativeId: string;
        tracking: TrackingMode;
      }>;
    }>;
  }>;
};

async function graphRequest<T>(
  path: string,
  method: 'GET' | 'POST',
  params: Record<string, string> = {},
): Promise<T> {
  const url = new URL(`${graphOrigin}/${path.replace(/^\//, '')}`);
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${token}` },
  };
  if (method === 'GET') {
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  } else {
    init.headers = {
      ...init.headers,
      'Content-Type': 'application/x-www-form-urlencoded',
    };
    init.body = new URLSearchParams(params);
  }

  const response = await fetch(url, init);
  const text = await response.text();
  let parsed: GraphEnvelope<unknown>;
  try {
    parsed = JSON.parse(text) as GraphEnvelope<unknown>;
  } catch {
    throw new Error(`Meta returned non-JSON HTTP ${response.status}`);
  }

  if (!response.ok || parsed.error) {
    const error = parsed.error;
    const code = [error?.code, error?.error_subcode].filter((value) => value !== undefined).join('/');
    throw new Error(
      `Meta API ${method} ${path} failed (${response.status}${code ? `, code ${code}` : ''}): ${error?.message ?? 'unknown Meta error'}`,
    );
  }
  return parsed as T;
}

async function list<T extends NamedEntity>(path: string, fields: string): Promise<T[]> {
  const result = await graphRequest<GraphEnvelope<T>>(path, 'GET', {
    fields,
    limit: '500',
  });
  return result.data ?? [];
}

async function create(path: string, params: Record<string, string>): Promise<string> {
  if (dryRun) return `dry-run:${path}:${params.name ?? 'unnamed'}`;
  const result = await graphRequest<GraphEnvelope<never>>(path, 'POST', params);
  if (!result.id) throw new Error(`Meta ${path} creation succeeded without returning an id`);
  return result.id;
}

function exactName<T extends NamedEntity>(rows: T[], name: string): T | undefined {
  return rows.find((row) => row.name === name);
}

async function accountMetadata() {
  const result = await graphRequest<{
    id?: string;
    name?: string;
    currency?: string;
    timezone_name?: string;
  }>(accountPath, 'GET', {
    fields: 'id,name,currency,timezone_name',
  });
  return {
    id: result.id ?? accountPath,
    name: result.name ?? null,
    currency: result.currency ?? null,
    timezoneName: result.timezone_name ?? null,
  };
}

async function ensureImageHash(): Promise<string | null> {
  if (configuredImageHash) return configuredImageHash;
  if (!imageUrl) return null;
  if (dryRun) return 'dry-run-image-hash';

  const result = await graphRequest<GraphEnvelope<never>>(`${accountPath}/adimages`, 'POST', {
    url: imageUrl,
  });
  const first = Object.values(result.images ?? {})[0];
  if (!first?.hash) throw new Error('Meta image upload succeeded but no image hash was returned');
  return first.hash;
}

async function ensureCampaign(existing: Campaign[], name: string): Promise<string> {
  const found = exactName(existing, name);
  if (found) return found.id;
  return create(`${accountPath}/campaigns`, {
    name,
    objective: 'OUTCOME_TRAFFIC',
    special_ad_categories: '[]',
    buying_type: 'AUCTION',
    status: 'PAUSED',
  });
}

async function ensureAdSet(
  existing: AdSet[],
  campaignId: string,
  name: string,
): Promise<string> {
  const found = existing.find((row) => row.name === name && row.campaign_id === campaignId);
  if (found) return found.id;
  return create(`${accountPath}/adsets`, {
    name,
    campaign_id: campaignId,
    optimization_goal: 'LINK_CLICKS',
    billing_event: 'IMPRESSIONS',
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    daily_budget: '2000',
    targeting: JSON.stringify({
      age_min: 21,
      age_max: 65,
      geo_locations: { countries: ['GB'] },
    }),
    status: 'PAUSED',
  });
}

function trackingTags(mode: TrackingMode): string | null {
  if (mode === 'MISSING') return null;
  if (mode === 'PARTIAL') return 'stride_meta_campaign_id={{campaign.id}}';
  return [
    'stride_meta_campaign_id={{campaign.id}}',
    'stride_meta_adset_id={{adset.id}}',
    'stride_meta_ad_id={{ad.id}}',
  ].join('&');
}

async function ensureCreative(
  existing: Creative[],
  imageHash: string,
  name: string,
  mode: TrackingMode,
): Promise<string> {
  const found = exactName(existing, name);
  if (found) return found.id;

  const params: Record<string, string> = {
    name,
    object_story_spec: JSON.stringify({
      page_id: pageId,
      link_data: {
        message: `Stride Meta sandbox scenario: ${name}`,
        link: destinationUrl,
        image_hash: imageHash,
        call_to_action: { type: 'LEARN_MORE' },
      },
    }),
  };
  const tags = trackingTags(mode);
  if (tags) params.url_tags = tags;
  return create(`${accountPath}/adcreatives`, params);
}

async function ensureAd(
  existing: Ad[],
  adSetId: string,
  creativeId: string,
  name: string,
): Promise<string> {
  const found = existing.find((row) => row.name === name && row.adset_id === adSetId);
  if (found) return found.id;
  return create(`${accountPath}/ads`, {
    name,
    adset_id: adSetId,
    creative: JSON.stringify({ creative_id: creativeId }),
    status: 'PAUSED',
  });
}

const campaignSpecs = [
  { key: '01', label: 'Prospecting' },
  { key: '02', label: 'Retargeting' },
  { key: '03', label: 'Tracking Audit' },
] as const;
const trackingModes: TrackingMode[] = ['MISSING', 'PARTIAL', 'EXACT'];

async function main() {
  const account = await accountMetadata();
  const [campaigns, adSets, creatives, ads] = await Promise.all([
    list<Campaign>(`${accountPath}/campaigns`, 'id,name,status'),
    list<AdSet>(`${accountPath}/adsets`, 'id,name,campaign_id,status'),
    list<Creative>(`${accountPath}/adcreatives`, 'id,name'),
    list<Ad>(`${accountPath}/ads`, 'id,name,adset_id,status'),
  ]);
  const imageHash = await ensureImageHash();
  const manifest: CreatedManifest = { account, imageHash, campaigns: [] };

  if (!imageHash && !dryRun) {
    throw new Error(
      'Set META_SANDBOX_IMAGE_HASH or META_SANDBOX_IMAGE_URL so the seeder can create creatives and ads',
    );
  }

  let trackingIndex = 0;
  for (const campaignSpec of campaignSpecs) {
    const campaignName = `SCN | ${campaignSpec.key} | ${campaignSpec.label}`;
    const campaignId = await ensureCampaign(campaigns, campaignName);
    const campaignManifest: CreatedManifest['campaigns'][number] = {
      id: campaignId,
      name: campaignName,
      adSets: [],
    };

    for (let adSetNumber = 1; adSetNumber <= 2; adSetNumber += 1) {
      const adSetName = `${campaignName} | Ad Set ${adSetNumber}`;
      const adSetId = await ensureAdSet(adSets, campaignId, adSetName);
      const adSetManifest: CreatedManifest['campaigns'][number]['adSets'][number] = {
        id: adSetId,
        name: adSetName,
        ads: [],
      };

      for (let adNumber = 1; adNumber <= 2; adNumber += 1) {
        const mode = trackingModes[trackingIndex % trackingModes.length]!;
        trackingIndex += 1;
        const suffix = `A${adSetNumber}-${adNumber}`;
        const creativeName = `${campaignName} | Creative ${suffix} | ${mode}`;
        const creativeId = await ensureCreative(
          creatives,
          imageHash ?? 'dry-run-image-hash',
          creativeName,
          mode,
        );
        const adName = `${campaignName} | Ad ${suffix} | ${mode}`;
        const adId = await ensureAd(ads, adSetId, creativeId, adName);
        adSetManifest.ads.push({ id: adId, name: adName, creativeId, tracking: mode });
      }
      campaignManifest.adSets.push(adSetManifest);
    }
    manifest.campaigns.push(campaignManifest);
  }

  const totalAds = manifest.campaigns.reduce(
    (sum, campaign) => sum + campaign.adSets.reduce((nested, adSet) => nested + adSet.ads.length, 0),
    0,
  );

  if (asJson) {
    console.log(JSON.stringify({ dryRun, totalAds, ...manifest }, null, 2));
    return;
  }

  console.log(`Meta sandbox: ${account.name ?? account.id}`);
  console.log(`Currency/time zone: ${account.currency ?? 'unknown'} / ${account.timezoneName ?? 'unknown'}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'WRITE'}`);
  console.log(`Campaigns: ${manifest.campaigns.length}`);
  console.log(`Ad sets: ${manifest.campaigns.reduce((sum, row) => sum + row.adSets.length, 0)}`);
  console.log(`Ads: ${totalAds}`);
  console.log('Tracking states are deliberately mixed across MISSING / PARTIAL / EXACT.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Unknown Meta sandbox seeding error');
  process.exitCode = 1;
});
