/// <reference types="node" />
import 'dotenv/config';

import { createHmac } from 'node:crypto';
import { env } from '../src/config/env.js';
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

if (env.NODE_ENV !== 'development') {
  throw new Error('Sandbox intelligence test is development-only. Set NODE_ENV=development.');
}

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const accessToken = required('META_SANDBOX_ACCESS_TOKEN');
const rawAccountId = required('META_SANDBOX_AD_ACCOUNT_ID').replace(/^act_/, '');
const accountId = `act_${rawAccountId}`;
const apiVersion = process.env.META_SANDBOX_API_VERSION?.trim() || env.META_API_VERSION;
const lookbackDays = Number(process.env.META_SANDBOX_TEST_LOOKBACK_DAYS ?? '28');

if (!Number.isInteger(lookbackDays) || lookbackDays < 2 || lookbackDays > 90) {
  throw new Error('META_SANDBOX_TEST_LOOKBACK_DAYS must be an integer between 2 and 90');
}

interface MetaRecord {
  [key: string]: unknown;
}

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

interface CampaignRow {
  id: string;
  name: string;
  status?: string;
  effective_status?: string;
  objective?: string;
}

interface Period {
  since: string;
  until: string;
  start: Date;
  end: Date;
}

function printJson(label: string, value: unknown): void {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(value, null, 2));
}

function number(value: unknown): number {
  const parsed = Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
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

function queryString(params: Record<string, string>): string {
  const search = new URLSearchParams(params);
  search.set(
    'appsecret_proof',
    createHmac('sha256', required('META_APP_SECRET')).update(accessToken).digest('hex'),
  );
  return search.toString();
}

async function graph<T>(path: string, params: Record<string, string>): Promise<T> {
  const url = new URL(`https://graph.facebook.com/${apiVersion}${path}`);
  url.search = queryString(params);

  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  const body = (await response.json()) as MetaRecord;

  if (!response.ok || body.error) {
    const error = body.error as MetaRecord | undefined;
    throw new Error(
      `Meta API error: ${String(error?.message ?? response.statusText)}${
        error?.code ? ` (code ${String(error.code)})` : ''
      }`,
    );
  }

  return body as T;
}

async function collect<T extends MetaRecord>(
  path: string,
  params: Record<string, string>,
): Promise<T[]> {
  const result: T[] = [];
  let after: string | undefined;

  while (true) {
    const payload = await graph<MetaRecord>(path, {
      ...params,
      ...(after ? { after } : {}),
    });
    const data = Array.isArray(payload.data) ? payload.data : [];
    result.push(...(data as T[]));

    const paging = payload.paging as MetaRecord | undefined;
    const cursors = paging?.cursors as MetaRecord | undefined;
    const next = typeof cursors?.after === 'string' ? cursors.after : undefined;
    if (!paging?.next || !next) break;
    after = next;
  }

  return result;
}

function recommendationOutput(recommendations: RecommendationDraft[]): void {
  console.log('\n=== Recommendations ===');

  if (recommendations.length === 0) {
    console.log('No Meta-only recommendations were emitted for the current sandbox data/window.');
    return;
  }

  for (const [index, recommendation] of recommendations.entries()) {
    console.log(`\n#${index + 1} ${recommendation.title}`);
    console.log(`Rule: ${recommendation.ruleId}`);
    console.log(`Entity: ${recommendation.entityType} ${recommendation.externalEntityId}`);
    console.log(`Action: ${recommendation.suggestedAction}`);
    console.log(`Severity: ${recommendation.severity}`);
    console.log(
      `Priority inputs: impact=${recommendation.impactScore.toFixed(4)}, urgency=${recommendation.urgencyScore.toFixed(4)}`,
    );
    console.log(`Confidence: ${recommendation.confidenceScore.toFixed(2)}`);
    console.log(`Evidence quality: ${recommendation.evidenceQuality}`);
    console.log(`Message: ${recommendation.summary}`);
    if (recommendation.limitations.length > 0) {
      console.log(`Limitations: ${recommendation.limitations.map((item) => item.code).join(', ')}`);
    }
  }
}

async function main(): Promise<void> {
  const current = period(Math.floor(lookbackDays / 2), 0);
  const comparison = period(Math.ceil(lookbackDays / 2), Math.floor(lookbackDays / 2));

  console.log('\nStride Meta sandbox → direct intelligence-rule test');
  console.log(`Account: ${accountId}`);
  console.log(`API: ${apiVersion}`);
  console.log(`Current: ${current.since} → ${current.until}`);
  console.log(`Comparison: ${comparison.since} → ${comparison.until}`);

  console.log('\n[1/4] Fetching sandbox campaigns...');
  const campaigns = await collect<CampaignRow>(`/${accountId}/campaigns`, {
    fields: 'id,name,status,effective_status,objective',
    limit: '100',
  });
  printJson('Campaigns', campaigns);

  console.log('\n[2/4] Fetching campaign-level insights...');
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

  const [currentCampaignRows, comparisonCampaignRows] = await Promise.all([
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
  ]);

  console.log(`Current campaign insight rows: ${currentCampaignRows.length}`);
  console.log(`Comparison campaign insight rows: ${comparisonCampaignRows.length}`);

  console.log('\n[3/4] Fetching ad-level insights for creative-fatigue signals...');
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

  const [currentAdRows, comparisonAdRows] = await Promise.all([
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

  const currency = process.env.META_SANDBOX_CURRENCY?.trim() || 'UNKNOWN';
  const totalCurrentCampaignSpend = currentCampaignRows.reduce(
    (sum, row) => sum + number(row.spend),
    0,
  );
  const totalCurrentAdSpend = currentAdRows.reduce((sum, row) => sum + number(row.spend), 0);

  console.log('\n[4/4] Feeding normalized Meta evidence directly into the existing deterministic rules...');

  const recommendations: RecommendationDraft[] = [];

  const campaignIds = new Set<string>([
    ...currentCampaignRows.map((row) => row.campaign_id).filter((id): id is string => Boolean(id)),
    ...comparisonCampaignRows.map((row) => row.campaign_id).filter((id): id is string => Boolean(id)),
  ]);

  for (const campaignId of campaignIds) {
    const currentRows = currentCampaignRows.filter((row) => row.campaign_id === campaignId);
    const comparisonRows = comparisonCampaignRows.filter((row) => row.campaign_id === campaignId);
    const campaign = campaigns.find((item) => item.id === campaignId);
    const evidence = buildEvidence(
      campaignId,
      campaign?.name ?? currentRows[0]?.campaign_name ?? campaignId,
      currency,
      currentRows,
      comparisonRows,
      current.start,
      current.end,
      totalCurrentCampaignSpend,
    );
    const recommendation = campaignEfficiencyRule(evidence);
    if (recommendation) recommendations.push(recommendation);
  }

  const adIds = new Set<string>([
    ...currentAdRows.map((row) => row.ad_id).filter((id): id is string => Boolean(id)),
    ...comparisonAdRows.map((row) => row.ad_id).filter((id): id is string => Boolean(id)),
  ]);

  for (const adId of adIds) {
    const currentRows = currentAdRows.filter((row) => row.ad_id === adId);
    const comparisonRows = comparisonAdRows.filter((row) => row.ad_id === adId);
    const evidence: CreativeEvidence = buildEvidence(
      adId,
      currentRows[0]?.ad_name ?? adId,
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

  printJson('Fetched data summary', {
    campaigns: campaigns.length,
    campaignInsightRows: {
      current: currentCampaignRows.length,
      comparison: comparisonCampaignRows.length,
    },
    adInsightRows: {
      current: currentAdRows.length,
      comparison: comparisonAdRows.length,
    },
    currentSpend: totalCurrentCampaignSpend,
    comparisonSpend: comparisonCampaignRows.reduce((sum, row) => sum + number(row.spend), 0),
  });

  recommendationOutput(recommendations);

  console.log('\n=== Scope ===');
  console.log('Evaluated directly: campaign efficiency + creative fatigue rules.');
  console.log('Not evaluated: Shopify/product/inventory rules, because this script intentionally bypasses the app database and fetches Meta sandbox data only.');
  console.log(`\nCompleted. ${recommendations.length} Meta recommendation(s) emitted.`);
}

main().catch((error) => {
  console.error('\nSandbox intelligence test failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
