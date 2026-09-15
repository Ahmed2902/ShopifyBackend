/// <reference types="node" />
import 'dotenv/config';

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

if (process.env.NODE_ENV === 'production') {
  throw new Error('Meta sandbox seeding is disabled when NODE_ENV=production');
}

const token = required('META_SANDBOX_ACCESS_TOKEN');
const rawAccountId = required('META_SANDBOX_AD_ACCOUNT_ID');
const pageId = required('META_SANDBOX_PAGE_ID');
const apiVersion = process.env.META_SANDBOX_API_VERSION?.trim() || 'v26.0';
const destinationUrl = process.env.META_SANDBOX_DESTINATION_URL?.trim() || 'https://example.com';
const configuredImageHash = process.env.META_SANDBOX_IMAGE_HASH?.trim() || null;
const imageUrl = process.env.META_SANDBOX_IMAGE_URL?.trim() || null;
const objectStoryId = process.env.META_SANDBOX_OBJECT_STORY_ID?.trim() || null;

const dryRun =
  process.argv.includes('--dry-run') || process.env.npm_config_dry_run?.toLowerCase() === 'true';
const asJson = process.argv.includes('--json');
const listPagePosts = process.argv.includes('--list-page-posts');
const writeConfirmed =
  process.argv.includes('--confirm-sandbox-write') ||
  process.env.npm_config_confirm_sandbox_write?.toLowerCase() === 'true';

const accountId = rawAccountId.replace(/^act_/, '');
const accountPath = `act_${accountId}`;
const confirmedAccountId = (process.env.META_SANDBOX_CONFIRM_AD_ACCOUNT_ID?.trim() || '').replace(
  /^act_/,
  '',
);
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

if (objectStoryId) {
  if (!/^\d+_\d+$/.test(objectStoryId)) {
    throw new Error(
      'META_SANDBOX_OBJECT_STORY_ID must look like <PAGE_ID>_<POST_ID>, for example 1171948176011994_123456789.',
    );
  }
  if (!objectStoryId.startsWith(`${pageId}_`)) {
    throw new Error('META_SANDBOX_OBJECT_STORY_ID must belong to META_SANDBOX_PAGE_ID.');
  }
}

// Listing Page posts is read-only. Every other non-dry-run path can write to Meta and therefore needs
// two independent, account-specific confirmations so a typo cannot seed a live merchant account.
if (!dryRun && !listPagePosts) {
  if (!writeConfirmed) {
    throw new Error(
      'Write mode requires --confirm-sandbox-write. Prefer `npm run dev:meta-sandbox-seed:write`.',
    );
  }
  if (!confirmedAccountId || confirmedAccountId !== accountId) {
    throw new Error(
      'Write mode requires META_SANDBOX_CONFIRM_AD_ACCOUNT_ID to exactly match META_SANDBOX_AD_ACCOUNT_ID.',
    );
  }
}

type GraphError = {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  error_data?: unknown;
  error_user_title?: string;
  error_user_msg?: string;
  fbtrace_id?: string;
};

type GraphEnvelope<T> = {
  data?: T[];
  id?: string;
  paging?: {
    next?: string;
    cursors?: { after?: string };
  };
  error?: GraphError;
};

type NamedEntity = { id: string; name: string };
type Campaign = NamedEntity & { status?: string };
type AdSet = NamedEntity & { campaign_id?: string; status?: string };
type Creative = NamedEntity;
type Ad = NamedEntity & { adset_id?: string; status?: string };
type PagePost = {
  id: string;
  message?: string;
  permalink_url?: string;
  created_time?: string;
};

type TrackingMode = 'MISSING' | 'PARTIAL' | 'EXACT';
type CreativeSource =
  | { kind: 'EXISTING_PAGE_POST'; value: string }
  | { kind: 'IMAGE_HASH'; value: string }
  | { kind: 'PICTURE_URL'; value: string };

type CreatedManifest = {
  account: {
    id: string;
    name: string | null;
    currency: string | null;
    timezoneName: string | null;
  };
  creativeSource: CreativeSource['kind'] | 'DRY_RUN_PLACEHOLDER';
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
    const code = [error?.code, error?.error_subcode]
      .filter((value) => value !== undefined)
      .join('/');

    if (method === 'POST' && path.endsWith('/adcreatives') && error?.error_subcode === 1885183) {
      throw new Error(
        [
          'Meta blocked creation of a new unpublished Page post because the Meta app is in Development mode (subcode 1885183).',
          'For sandbox testing, do not switch the app Live just to bypass this.',
          `Create or reuse a published post on Facebook Page ${pageId}, then set META_SANDBOX_OBJECT_STORY_ID to the Graph post id (<PAGE_ID>_<POST_ID>).`,
          'Run `npm run dev:meta-sandbox-posts` to list recent Page post IDs after the token has pages_read_engagement.',
          'Then rerun `npm run dev:meta-sandbox-seed:write`.',
          error?.fbtrace_id ? `fbtrace_id=${error.fbtrace_id}` : '',
        ]
          .filter(Boolean)
          .join(' '),
      );
    }

    const details = [
      error?.error_user_title,
      error?.error_user_msg,
      typeof error?.error_data === 'string'
        ? error.error_data
        : error?.error_data
          ? JSON.stringify(error.error_data)
          : undefined,
      error?.fbtrace_id ? `fbtrace_id=${error.fbtrace_id}` : undefined,
    ].filter((value): value is string => Boolean(value));

    throw new Error(
      `Meta API ${method} ${path} failed (${response.status}${code ? `, code ${code}` : ''}): ${error?.message ?? 'unknown Meta error'}${details.length ? ` — ${details.join(' | ')}` : ''}`,
    );
  }

  return parsed as T;
}

function pagingAfter<T>(result: GraphEnvelope<T>): string | null {
  const direct = result.paging?.cursors?.after?.trim();
  if (direct) return direct;
  const next = result.paging?.next;
  if (!next) return null;
  try {
    return new URL(next).searchParams.get('after');
  } catch {
    return null;
  }
}

async function list<T>(path: string, fields: string, limit = '500'): Promise<T[]> {
  const rows: T[] = [];
  const seenCursors = new Set<string>();
  let after: string | null = null;

  while (true) {
    const result = await graphRequest<GraphEnvelope<T>>(path, 'GET', {
      fields,
      limit,
      ...(after ? { after } : {}),
    });
    rows.push(...(result.data ?? []));

    if (!result.paging?.next) return rows;
    const nextAfter = pagingAfter(result);
    if (!nextAfter) {
      throw new Error(`Meta pagination for ${path} returned a next page without an after cursor`);
    }
    if (seenCursors.has(nextAfter)) {
      throw new Error(`Meta pagination for ${path} returned a repeated after cursor`);
    }
    seenCursors.add(nextAfter);
    after = nextAfter;
  }
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

function resolveCreativeSource(): CreativeSource {
  // Development-mode apps cannot create the unpublished Page post generated by object_story_spec.
  // Reusing a published Page post through object_story_id avoids that restriction while still letting
  // each ad creative carry its own url_tags for MISSING / PARTIAL / EXACT tracking scenarios.
  if (objectStoryId) return { kind: 'EXISTING_PAGE_POST', value: objectStoryId };
  if (configuredImageHash) return { kind: 'IMAGE_HASH', value: configuredImageHash };
  if (imageUrl) return { kind: 'PICTURE_URL', value: imageUrl };
  if (dryRun) return { kind: 'IMAGE_HASH', value: 'dry-run-image-hash' };

  throw new Error(
    'Set META_SANDBOX_OBJECT_STORY_ID to an existing published Page post (recommended while the Meta app is in Development mode), or provide META_SANDBOX_IMAGE_HASH / META_SANDBOX_IMAGE_URL when the app is allowed to create ad stories.',
  );
}

async function printRecentPagePosts() {
  const posts = await list<PagePost>(
    `${pageId}/posts`,
    'id,message,permalink_url,created_time',
    '25',
  );

  if (!posts.length) {
    console.log(`No published posts were returned for Page ${pageId}.`);
    console.log('Create a normal published Page post first, then rerun this command.');
    return;
  }

  if (asJson) {
    console.log(JSON.stringify(posts, null, 2));
    return;
  }

  console.log(`Recent published posts for Page ${pageId}:`);
  for (const post of posts) {
    const preview = (post.message ?? '(no text)').replace(/\s+/g, ' ').slice(0, 90);
    console.log(`\n${post.id}`);
    console.log(`  ${post.created_time ?? 'unknown time'} · ${preview}`);
    if (post.permalink_url) console.log(`  ${post.permalink_url}`);
  }
  console.log('\nCopy the id you want into META_SANDBOX_OBJECT_STORY_ID.');
}

async function ensureCampaign(existing: Campaign[], name: string): Promise<string> {
  const found = exactName(existing, name);
  if (found) return found.id;
  return create(`${accountPath}/campaigns`, {
    name,
    objective: 'OUTCOME_TRAFFIC',
    special_ad_categories: '[]',
    buying_type: 'AUCTION',
    is_adset_budget_sharing_enabled: 'false',
    status: 'PAUSED',
  });
}

async function ensureAdSet(existing: AdSet[], campaignId: string, name: string): Promise<string> {
  const found = existing.find((row) => row.name === name && row.campaign_id === campaignId);
  if (found) return found.id;

  return create(`${accountPath}/adsets`, {
    name,
    campaign_id: campaignId,
    optimization_goal: 'LINK_CLICKS',
    billing_event: 'IMPRESSIONS',
    bid_strategy: 'LOWEST_COST_WITHOUT_CAP',
    daily_budget: '6000',
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
  source: CreativeSource,
  name: string,
  mode: TrackingMode,
): Promise<string> {
  const found = exactName(existing, name);
  if (found) return found.id;

  const params: Record<string, string> = { name };

  if (source.kind === 'EXISTING_PAGE_POST') {
    params.object_story_id = source.value;
  } else {
    const mediaField =
      source.kind === 'IMAGE_HASH' ? { image_hash: source.value } : { picture: source.value };

    params.object_story_spec = JSON.stringify({
      page_id: pageId,
      link_data: {
        message: `Stride Meta sandbox scenario: ${name}`,
        link: destinationUrl,
        ...mediaField,
        call_to_action: { type: 'LEARN_MORE' },
      },
    });
  }

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
  if (listPagePosts) {
    await printRecentPagePosts();
    return;
  }

  const account = await accountMetadata();
  const returnedAccountId = account.id.replace(/^act_/, '');
  if (!dryRun && returnedAccountId !== accountId) {
    throw new Error('Meta returned an account ID that does not match the confirmed write target.');
  }

  const [campaigns, adSets, creatives, ads] = await Promise.all([
    list<Campaign>(`${accountPath}/campaigns`, 'id,name,status'),
    list<AdSet>(`${accountPath}/adsets`, 'id,name,campaign_id,status'),
    list<Creative>(`${accountPath}/adcreatives`, 'id,name'),
    list<Ad>(`${accountPath}/ads`, 'id,name,adset_id,status'),
  ]);

  const source = resolveCreativeSource();
  const manifest: CreatedManifest = {
    account,
    creativeSource:
      dryRun && !objectStoryId && !configuredImageHash && !imageUrl
        ? 'DRY_RUN_PLACEHOLDER'
        : source.kind,
    campaigns: [],
  };

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
        const creativeId = await ensureCreative(creatives, source, creativeName, mode);
        const adName = `${campaignName} | Ad ${suffix} | ${mode}`;
        const adId = await ensureAd(ads, adSetId, creativeId, adName);
        adSetManifest.ads.push({ id: adId, name: adName, creativeId, tracking: mode });
      }

      campaignManifest.adSets.push(adSetManifest);
    }

    manifest.campaigns.push(campaignManifest);
  }

  const totalAds = manifest.campaigns.reduce(
    (sum, campaign) =>
      sum + campaign.adSets.reduce((nested, adSet) => nested + adSet.ads.length, 0),
    0,
  );

  if (asJson) {
    console.log(JSON.stringify({ dryRun, totalAds, ...manifest }, null, 2));
    return;
  }

  console.log(`Meta sandbox: ${account.name ?? account.id}`);
  console.log(
    `Currency/time zone: ${account.currency ?? 'unknown'} / ${account.timezoneName ?? 'unknown'}`,
  );
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'WRITE'}`);
  console.log(`Creative source: ${manifest.creativeSource}`);
  console.log(`Campaigns: ${manifest.campaigns.length}`);
  console.log(`Ad sets: ${manifest.campaigns.reduce((sum, row) => sum + row.adSets.length, 0)}`);
  console.log(`Ads: ${totalAds}`);
  console.log('Tracking states are deliberately mixed across MISSING / PARTIAL / EXACT.');
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Unknown Meta sandbox seeding error');
  process.exitCode = 1;
});
