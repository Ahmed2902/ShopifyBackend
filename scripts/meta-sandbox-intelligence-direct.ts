/// <reference types="node" />
import 'dotenv/config';

import {
  campaignEfficiencyRule,
  creativeFatigueRule,
} from '../src/modules/intelligence/intelligence.rules.js';
import type {
  CampaignEvidence,
  CreativeEvidence,
  HistoricalMetrics,
  RecommendationDraft,
} from '../src/modules/intelligence/intelligence.types.js';

if (process.env.NODE_ENV === 'production') {
  throw new Error('Meta sandbox intelligence testing is disabled in production.');
}

function argValue(name: string): string | undefined {
  const prefix = `${name}=`;
  const entry = process.argv.find((value) => value.startsWith(prefix));
  return entry?.slice(prefix.length).trim() || undefined;
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

function enabled(name: string): boolean {
  return ['1', 'true', 'yes', 'on'].includes((process.env[name] ?? '').trim().toLowerCase());
}

const accessToken = required('META_SANDBOX_ACCESS_TOKEN');
const rawAccountId = (argValue('--account-id') ?? required('META_SANDBOX_AD_ACCOUNT_ID')).replace(
  /^act_/,
  '',
);
const accountId = `act_${rawAccountId}`;
const apiVersion =
  argValue('--api-version') ??
  process.env.META_SANDBOX_API_VERSION?.trim() ??
  process.env.META_API_VERSION?.trim() ??
  'v26.0';
const lookbackDays = Number(
  argValue('--lookback-days') ?? process.env.META_SANDBOX_TEST_LOOKBACK_DAYS ?? '28',
);
const fixtureMetrics = process.argv.includes('--fixture-metrics') || enabled('META_SANDBOX_FIXTURE_METRICS');

if (!/^\d+$/.test(rawAccountId)) {
  throw new Error('META_SANDBOX_AD_ACCOUNT_ID/--account-id must be a numeric ID or act_<numeric ID>');
}
if (!/^v\d+\.\d+$/.test(apiVersion)) {
  throw new Error('META_SANDBOX_API_VERSION/--api-version must look like v26.0');
}
if (!Number.isInteger(lookbackDays) || lookbackDays < 2 || lookbackDays > 90) {
  throw new Error('META_SANDBOX_TEST_LOOKBACK_DAYS/--lookback-days must be an integer between 2 and 90');
}

type MetaRecord = Record<string, unknown>;

type GraphError = {
  message?: string;
  type?: string;
  code?: number;
  error_subcode?: number;
  fbtrace_id?: string;
};

type GraphEnvelope<T> = {
  data?: T[];
  paging?: {
    next?: string;
    cursors?: { after?: string };
  };
  error?: GraphError;
};

interface InsightRow extends MetaRecord {
  campaign_id?: string;
  campaign_name?: string;
  ad_id?: string;
  ad_name?: string;
  spend?: string;
  impressions?: string;
  reach?: string;
  clicks?: string;
  ctr?: string;
  cpc?: string;
  cpm?: string;
  frequency?: string;
  actions?: Array<{ action_type?: string; value?: string }>;
  action_values?: Array<{ action_type?: string; value?: string }>;
}

interface CampaignRow extends MetaRecord {
  id: string;
  name: string;
  status?: string;
  effective_status?: string;
  objective?: string;
}

interface AdRow extends MetaRecord {
  id: string;
  name: string;
  campaign_id?: string;
  status?: string;
  effective_status?: string;
}

interface Period {
  since: string;
  until: string;
  start: Date;
  end: Date;
}

function dateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function period(days: number, offset: number): Period {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  end.setUTCDate(end.getUTCDate() - offset);

  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days + 1);

  return { since: dateOnly(start), until: dateOnly(end), start, end };
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function actionValue(rows: InsightRow[], actionType: string): number {
  return rows.reduce((total, row) => {
    const value = row.action_values?.find((item) => item.action_type === actionType)?.value;
    return total + number(value);
  }, 0);
}

function actionCount(rows: InsightRow[], actionType: string): number {
  return rows.reduce((total, row) => {
    const value = row.actions?.find((item) => item.action_type === actionType)?.value;
    return total + number(value);
  }, 0);
}

function aggregate(rows: InsightRow[]): HistoricalMetrics {
  const spend = rows.reduce((sum, row) => sum + number(row.spend), 0);
  const impressions = rows.reduce((sum, row) => sum + number(row.impressions), 0);
  const reach = rows.reduce((sum, row) => sum + number(row.reach), 0);
  const clicks = rows.reduce((sum, row) => sum + number(row.clicks), 0);
  const purchases = actionCount(rows, 'purchase');
  const purchaseValue = actionValue(rows, 'purchase');

  return {
    spend,
    impressions,
    reach: reach > 0 ? reach : null,
    clicks,
    purchases,
    purchaseValue,
    roas: spend > 0 ? purchaseValue / spend : null,
    cpa: purchases > 0 ? spend / purchases : null,
    ctr: impressions > 0 ? clicks / impressions : null,
    cpc: clicks > 0 ? spend / clicks : null,
    cpm: impressions > 0 ? (spend / impressions) * 1000 : null,
    frequency: reach > 0 ? impressions / reach : null,
  };
}

function metrics(input: {
  spend: number;
  impressions: number;
  reach: number;
  clicks: number;
  purchases: number;
  purchaseValue: number;
}): HistoricalMetrics {
  return {
    ...input,
    roas: input.spend > 0 ? input.purchaseValue / input.spend : null,
    cpa: input.purchases > 0 ? input.spend / input.purchases : null,
    ctr: input.impressions > 0 ? input.clicks / input.impressions : null,
    cpc: input.clicks > 0 ? input.spend / input.clicks : null,
    cpm: input.impressions > 0 ? (input.spend / input.impressions) * 1000 : null,
    frequency: input.reach > 0 ? input.impressions / input.reach : null,
  };
}

function buildEvidence(
  id: string,
  name: string,
  currency: string,
  currentRows: InsightRow[],
  comparisonRows: InsightRow[],
  start: Date,
  end: Date,
  totalCurrentSpend: number,
): CampaignEvidence {
  const current = aggregate(currentRows);
  return {
    entityId: id,
    externalEntityId: id,
    name,
    currency,
    spendShare: totalCurrentSpend > 0 ? current.spend / totalCurrentSpend : 0,
    start,
    end,
    current,
    comparison: aggregate(comparisonRows),
  };
}

function fixtureCampaignEvidence(
  campaign: CampaignRow,
  currency: string,
  start: Date,
  end: Date,
  count: number,
): CampaignEvidence {
  return {
    entityId: campaign.id,
    externalEntityId: campaign.id,
    name: campaign.name,
    currency,
    spendShare: 1 / Math.max(count, 1),
    start,
    end,
    comparison: metrics({
      spend: 100,
      impressions: 10_000,
      reach: 7_500,
      clicks: 300,
      purchases: 10,
      purchaseValue: 500,
    }),
    current: metrics({
      spend: 140,
      impressions: 12_000,
      reach: 7_000,
      clicks: 240,
      purchases: 7,
      purchaseValue: 280,
    }),
  };
}

function fixtureCreativeEvidence(
  ad: AdRow,
  currency: string,
  start: Date,
  end: Date,
  count: number,
): CreativeEvidence {
  return {
    entityId: ad.id,
    externalEntityId: ad.id,
    name: ad.name,
    currency,
    spendShare: 1 / Math.max(count, 1),
    start,
    end,
    comparison: metrics({
      spend: 50,
      impressions: 8_000,
      reach: 6_000,
      clicks: 240,
      purchases: 8,
      purchaseValue: 400,
    }),
    current: metrics({
      spend: 60,
      impressions: 9_000,
      reach: 4_000,
      clicks: 135,
      purchases: 4,
      purchaseValue: 160,
    }),
  };
}

function providerError(path: string, status: number, error?: GraphError): Error {
  const code = [error?.code, error?.error_subcode]
    .filter((value) => value !== undefined)
    .join('/');
  const trace = error?.fbtrace_id ? ` fbtrace_id=${error.fbtrace_id}` : '';
  const base = `Meta API GET ${path} failed (HTTP ${status}${code ? `, code ${code}` : ''}): ${error?.message ?? 'unknown Meta error'}.${trace}`;

  if (error?.code === 200) {
    return new Error(
      `${base}\n\nMeta denied access to ${accountId}. This direct test does not use Business Manager discovery or the merchant OAuth token. It uses META_SANDBOX_ACCESS_TOKEN exactly as configured. Make sure that token belongs to the sandbox/test user that owns or can read ${accountId} and has ads_read/ads_management.`,
    );
  }

  if (error?.code === 190) {
    return new Error(
      `${base}\n\nMETA_SANDBOX_ACCESS_TOKEN is invalid or expired. Generate/refresh the sandbox user token and rerun the test.`,
    );
  }

  return new Error(base);
}

async function graph<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`https://graph.facebook.com/${apiVersion}${normalized}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  // Deliberately do not add appsecret_proof here. This is a development-only harness and the
  // sandbox token may come from a different Meta test-user context than the normal merchant OAuth
  // app credentials. The production Meta client continues to use appsecret_proof.
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const text = await response.text();

  let body: (GraphEnvelope<unknown> & MetaRecord) | null = null;
  try {
    body = text ? (JSON.parse(text) as GraphEnvelope<unknown> & MetaRecord) : null;
  } catch {
    throw new Error(`Meta returned a non-JSON response for GET ${normalized} (HTTP ${response.status})`);
  }

  if (!response.ok || body?.error) {
    throw providerError(normalized, response.status, body?.error);
  }

  return body as T;
}

async function collect<T extends MetaRecord>(
  path: string,
  params: Record<string, string>,
): Promise<T[]> {
  const result: T[] = [];
  const seen = new Set<string>();
  let after: string | undefined;

  while (true) {
    const payload = await graph<GraphEnvelope<T> & MetaRecord>(path, {
      ...params,
      ...(after ? { after } : {}),
    });
    result.push(...(payload.data ?? []));

    const next = payload.paging?.cursors?.after?.trim();
    if (!payload.paging?.next || !next) return result;
    if (seen.has(next)) throw new Error(`Meta pagination for ${path} repeated cursor ${next}`);
    seen.add(next);
    after = next;
  }
}

function printRecommendations(recommendations: RecommendationDraft[]): void {
  console.log('\n=== Recommendations ===');
  if (!recommendations.length) {
    console.log('No recommendations were emitted for the supplied evidence.');
    return;
  }

  for (const [index, recommendation] of recommendations.entries()) {
    console.log(`\n#${index + 1} ${recommendation.title}`);
    console.log(`Rule: ${recommendation.ruleId}`);
    console.log(`Entity: ${recommendation.entityType} ${recommendation.externalEntityId}`);
    console.log(`Suggested action: ${recommendation.suggestedAction}`);
    console.log(`Severity: ${recommendation.severity}`);
    console.log(`Confidence: ${recommendation.confidenceScore.toFixed(2)}`);
    console.log(`Evidence quality: ${recommendation.evidenceQuality}`);
    console.log(`Message: ${recommendation.summary}`);
  }
}

async function main(): Promise<void> {
  const current = period(Math.floor(lookbackDays / 2), 0);
  const comparison = period(Math.ceil(lookbackDays / 2), Math.floor(lookbackDays / 2));

  console.log('\nStride Meta sandbox → direct recommendation test');
  console.log(`Account: ${accountId}`);
  console.log(`API: ${apiVersion}`);
  console.log(`Current: ${current.since} → ${current.until}`);
  console.log(`Comparison: ${comparison.since} → ${comparison.until}`);
  console.log(`Metrics: ${fixtureMetrics ? 'deterministic fixtures attached to real sandbox entities' : 'Meta insights'}`);

  console.log('\n[1/5] Validating sandbox token and account access...');
  const me = await graph<{ id?: string }>('/me', { fields: 'id' });
  const account = await graph<{
    id?: string;
    name?: string;
    currency?: string;
    account_status?: number;
  }>(`/${accountId}`, {
    fields: 'id,name,currency,account_status',
  });
  console.log(`Token user: ${me.id ?? 'unknown'}`);
  console.log(`Sandbox account: ${account.name ?? account.id ?? accountId}`);

  console.log('\n[2/5] Fetching sandbox campaigns and ads...');
  const [campaigns, ads] = await Promise.all([
    collect<CampaignRow>(`/${accountId}/campaigns`, {
      fields: 'id,name,status,effective_status,objective',
      limit: '100',
    }),
    collect<AdRow>(`/${accountId}/ads`, {
      fields: 'id,name,campaign_id,status,effective_status',
      limit: '500',
    }),
  ]);
  console.log(`Campaigns: ${campaigns.length}`);
  console.log(`Ads: ${ads.length}`);

  const currency = process.env.META_SANDBOX_CURRENCY?.trim() || account.currency || 'UNKNOWN';
  const recommendations: RecommendationDraft[] = [];

  if (fixtureMetrics) {
    console.log('\n[3/5] Building deterministic metrics for the fetched Meta entities...');
    for (const campaign of campaigns) {
      const recommendation = campaignEfficiencyRule(
        fixtureCampaignEvidence(campaign, currency, current.start, current.end, campaigns.length),
      );
      if (recommendation) recommendations.push(recommendation);
    }
    for (const ad of ads) {
      const recommendation = creativeFatigueRule(
        fixtureCreativeEvidence(ad, currency, current.start, current.end, ads.length),
      );
      if (recommendation) recommendations.push(recommendation);
    }
    console.log('Fixture metrics intentionally exercise the production deterministic rules; they are not presented as Meta-observed performance.');
  } else {
    console.log('\n[3/5] Fetching current/comparison Meta insights...');
    const campaignFields = [
      'campaign_id',
      'campaign_name',
      'spend',
      'impressions',
      'reach',
      'clicks',
      'ctr',
      'cpc',
      'cpm',
      'frequency',
      'actions',
      'action_values',
    ].join(',');
    const adFields = [
      'ad_id',
      'ad_name',
      'campaign_id',
      'campaign_name',
      'spend',
      'impressions',
      'reach',
      'clicks',
      'ctr',
      'cpc',
      'cpm',
      'frequency',
      'actions',
      'action_values',
    ].join(',');

    const [currentCampaignRows, comparisonCampaignRows, currentAdRows, comparisonAdRows] =
      await Promise.all([
        collect<InsightRow>(`/${accountId}/insights`, {
          level: 'campaign',
          fields: campaignFields,
          time_range: JSON.stringify({ since: current.since, until: current.until }),
          limit: '500',
        }),
        collect<InsightRow>(`/${accountId}/insights`, {
          level: 'campaign',
          fields: campaignFields,
          time_range: JSON.stringify({ since: comparison.since, until: comparison.until }),
          limit: '500',
        }),
        collect<InsightRow>(`/${accountId}/insights`, {
          level: 'ad',
          fields: adFields,
          time_range: JSON.stringify({ since: current.since, until: current.until }),
          limit: '500',
        }),
        collect<InsightRow>(`/${accountId}/insights`, {
          level: 'ad',
          fields: adFields,
          time_range: JSON.stringify({ since: comparison.since, until: comparison.until }),
          limit: '500',
        }),
      ]);

    console.log(`Campaign insight rows: current=${currentCampaignRows.length}, comparison=${comparisonCampaignRows.length}`);
    console.log(`Ad insight rows: current=${currentAdRows.length}, comparison=${comparisonAdRows.length}`);

    console.log('\n[4/5] Feeding normalized Meta evidence into the existing deterministic rules...');
    const totalCurrentCampaignSpend = currentCampaignRows.reduce(
      (sum, row) => sum + number(row.spend),
      0,
    );
    const totalCurrentAdSpend = currentAdRows.reduce((sum, row) => sum + number(row.spend), 0);

    const campaignIds = new Set<string>([
      ...currentCampaignRows.map((row) => row.campaign_id).filter((id): id is string => Boolean(id)),
      ...comparisonCampaignRows
        .map((row) => row.campaign_id)
        .filter((id): id is string => Boolean(id)),
    ]);

    for (const campaignId of campaignIds) {
      const currentRows = currentCampaignRows.filter((row) => row.campaign_id === campaignId);
      const comparisonRows = comparisonCampaignRows.filter((row) => row.campaign_id === campaignId);
      const campaign = campaigns.find((item) => item.id === campaignId);
      const recommendation = campaignEfficiencyRule(
        buildEvidence(
          campaignId,
          campaign?.name ?? currentRows[0]?.campaign_name ?? campaignId,
          currency,
          currentRows,
          comparisonRows,
          current.start,
          current.end,
          totalCurrentCampaignSpend,
        ),
      );
      if (recommendation) recommendations.push(recommendation);
    }

    const adIds = new Set<string>([
      ...currentAdRows.map((row) => row.ad_id).filter((id): id is string => Boolean(id)),
      ...comparisonAdRows.map((row) => row.ad_id).filter((id): id is string => Boolean(id)),
    ]);

    for (const adId of adIds) {
      const currentRows = currentAdRows.filter((row) => row.ad_id === adId);
      const comparisonRows = comparisonAdRows.filter((row) => row.ad_id === adId);
      const ad = ads.find((item) => item.id === adId);
      const evidence: CreativeEvidence = buildEvidence(
        adId,
        ad?.name ?? currentRows[0]?.ad_name ?? adId,
        currency,
        currentRows,
        comparisonRows,
        current.start,
        current.end,
        totalCurrentAdSpend,
      );
      const recommendation = creativeFatigueRule(evidence);
      if (recommendation) recommendations.push(recommendation);
    }

    if (
      currentCampaignRows.length === 0 &&
      comparisonCampaignRows.length === 0 &&
      currentAdRows.length === 0 &&
      comparisonAdRows.length === 0
    ) {
      console.log('\nMeta returned no delivery insights for this sandbox account. That is normal for paused/non-delivering test ads.');
      console.log('Rerun with --fixture-metrics to attach deterministic performance metrics to the real fetched campaign/ad IDs and exercise the recommendation rules.');
    }
  }

  if (fixtureMetrics) {
    console.log('\n[4/5] Production rule evaluation completed using fixture performance metrics.');
  }
  console.log('\n[5/5] Recommendation output');
  printRecommendations(recommendations);

  console.log('\n=== Scope ===');
  console.log('This harness bypasses Meta Business/account discovery, DB persistence and merchant OAuth selection.');
  console.log('It evaluates the real campaign-efficiency and creative-fatigue rule implementations.');
  console.log('Shopify/product/inventory rules remain covered by the separate intelligence scenario harness.');
}

main().catch((error) => {
  console.error('\nSandbox intelligence test failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
