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
const configuredAccountId = process.env.META_SANDBOX_TEST_AD_ACCOUNT_ID?.trim() || '940046010384529';
const rawAccountId = configuredAccountId.replace(/^act_/, '');
const accountId = `act_${rawAccountId}`;
const apiVersion = process.env.META_SANDBOX_API_VERSION?.trim() || env.META_API_VERSION;
const requestedLookbackDays = Number(process.env.META_SANDBOX_TEST_LOOKBACK_DAYS ?? '28');

if (!Number.isInteger(requestedLookbackDays) || requestedLookbackDays < 2 || requestedLookbackDays > 90) {
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
  date_start?: string;
  date_stop?: string;
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

function periodFromEnd(days: number, endDate: Date): Period {
  const end = new Date(endDate);
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - days + 1);
  return { since: dateOnly(start), until: dateOnly(end), start, end };
}

function previousPeriod(current: Period): Period {
  const end = new Date(current.start);
  end.setUTCDate(end.getUTCDate() - 1);
  return periodFromEnd(
    Math.round((current.end.getTime() - current.start.getTime()) / 86_400_000) + 1,
    end,
  );
}

function latestInsightDate(rows: InsightRow[]): Date | null {
  const dates = rows
    .map((row) => row.date_start)
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(`${value}T00:00:00.000Z`))
    .filter((value) => !Number.isNaN(value.getTime()));
  if (dates.length === 0) return null;
  return new Date(Math.max(...dates.map((date) => date.getTime())));
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
    console.log('No Meta-only recommendations were emitted for the fetched sandbox data/window.');
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
  console.log('\nStride Meta sandbox → direct intelligence-rule test');
  console.log(`Account: ${accountId}`);
  console.log(`API: ${apiVersion}`);
  console.log(`Requested lookback: ${requestedLookbackDays} days`);

  console.log('\n[1/4] Fetching sandbox campaigns...');
  const campaigns = await collect<CampaignRow>(`/${accountId}/campaigns`, {
    fields: 'id,name,status,effective_status,objective',
    limit: '100',
  });
  printJson('Campaigns', campaigns);

  console.log('\n[2/4] Fetching available campaign insight history...');
  const insightFields = [
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
    'date_start',
    'date_stop',
  ].join(',');

  // Do not assume the sandbox has data in today's calendar window. Sandbox accounts can contain
  // historical fixture data on an older date range. Pull the available daily history first, then
  // anchor the comparison windows to the newest date Meta actually returned.
  const campaignHistory = await collect<InsightRow>(`/${accountId}/insights`, {
    level: 'campaign',
    fields: insightFields,
    date_preset: 'maximum',
    time_increment: '1',
    limit: '500',
  });

  if (campaignHistory.length === 0) {
    throw new Error(
      `Meta returned campaigns but zero campaign insight rows for ${accountId}. This means there is no insight history available to evaluate. Verify the sandbox account, token permissions, and that the sandbox contains delivered/test spend.`,
    );
  }

  const latestDate = latestInsightDate(campaignHistory);
  if (!latestDate) {
    throw new Error('Meta returned campaign insights without date_start values.');
  }

  const current = periodFromEnd(requestedLookbackDays, latestDate);
  const comparison = previousPeriod(current);
  const currentCampaignRows = campaignHistory.filter(
    (row) => row.date_start && row.date_start >= current.since && row.date_start <= current.until,
  );
  const comparisonCampaignRows = campaignHistory.filter(
    (row) => row.date_start && row.date_start >= comparison.since && row.date_start <= comparison.until,
  );

  console.log(`Latest Meta insight date: ${dateOnly(latestDate)}`);
  console.log(`Current: ${current.since} → ${current.until}`);
  console.log(`Comparison: ${comparison.since} → ${comparison.until}`);
  console.log(`Campaign history rows: ${campaignHistory.length}`);
  console.log(`Current campaign insight rows: ${currentCampaignRows.length}`);
  console.log(`Comparison campaign insight rows: ${comparisonCampaignRows.length}`);

  console.log('\n[3/4] Fetching available ad-level insight history for creative-fatigue signals...');
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
    'date_start',
    'date_stop',
  ].join(',');

  const adHistory = await collect<InsightRow>(`/${accountId}/insights`, {
    level: 'ad',
    fields: adFields,
    date_preset: 'maximum',
    time_increment: '1',
    limit: '500',
  });
  const currentAdRows = adHistory.filter(
    (row) => row.date_start && row.date_start >= current.since && row.date_start <= current.until,
  );
  const comparisonAdRows = adHistory.filter(
    (row) => row.date_start && row.date_start >= comparison.since && row.date_start <= comparison.until,
  );

  const currency = process.env.META_SANDBOX_CURRENCY?.trim() || 'UNKNOWN';
  const totalCurrentCampaignSpend = currentCampaignRows.reduce(
    (sum, row) => sum + number(row.spend),
    0,
  );
  const totalCurrentAdSpend = currentAdRows.reduce((sum, row) => sum + number(row.spend), 0);

  console.log(`Ad history rows: ${adHistory.length}`);
  console.log(`Current ad insight rows: ${currentAdRows.length}`);
  console.log(`Comparison ad insight rows: ${comparisonAdRows.length}`);

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
    accountId,
    campaigns: campaigns.length,
    campaignHistoryRows: campaignHistory.length,
    adHistoryRows: adHistory.length,
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
