/// <reference types="node" />
import 'dotenv/config';

import { recommendationDecision } from '../src/modules/intelligence/recommendation-decision.js';
import {
  campaignEfficiencyRule,
  creativeFatigueRule,
} from '../src/modules/intelligence/intelligence.rules.js';
import type {
  CampaignEvidence,
  CreativeEvidence,
  DecisionAction,
  DecisionConfidence,
  HistoricalMetrics,
  RecommendationDraft,
} from '../src/modules/intelligence/intelligence.types.js';

if (process.env.NODE_ENV === 'production') {
  throw new Error('Meta sandbox decision validation is disabled in production.');
}

function required(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
}

const accessToken = required('META_SANDBOX_ACCESS_TOKEN');
const rawAccountId = required('META_SANDBOX_AD_ACCOUNT_ID').replace(/^act_/, '');
const accountId = `act_${rawAccountId}`;
const apiVersion =
  process.env.META_SANDBOX_API_VERSION?.trim() ??
  process.env.META_API_VERSION?.trim() ??
  'v26.0';
const currencyOverride = process.env.META_SANDBOX_CURRENCY?.trim();

if (!/^\d+$/.test(rawAccountId)) {
  throw new Error('META_SANDBOX_AD_ACCOUNT_ID must be a numeric ID or act_<numeric ID>');
}
if (!/^v\d+\.\d+$/.test(apiVersion)) {
  throw new Error('META_SANDBOX_API_VERSION/META_API_VERSION must look like v26.0');
}

type MetaRecord = Record<string, unknown>;

type GraphError = {
  message?: string;
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

interface CampaignRow extends MetaRecord {
  id: string;
  name: string;
  status?: string;
  effective_status?: string;
}

interface AdRow extends MetaRecord {
  id: string;
  name: string;
  campaign_id?: string;
  status?: string;
  effective_status?: string;
}

interface ScenarioExpectation {
  label: string;
  expectedRule: string | null;
  expectedAction: DecisionAction | null;
  expectedConfidence: DecisionConfidence | null;
}

interface EvaluatedScenario extends ScenarioExpectation {
  entityType: 'CAMPAIGN' | 'CREATIVE';
  entityId: string;
  entityName: string;
  recommendation: RecommendationDraft | null;
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

function campaignScenario(index: number): {
  expectation: ScenarioExpectation;
  comparison: HistoricalMetrics;
  current: HistoricalMetrics;
} {
  const comparison = metrics({
    spend: 100,
    impressions: 10_000,
    reach: 7_500,
    clicks: 300,
    purchases: 10,
    purchaseValue: 500,
  });

  switch (index % 4) {
    case 0:
      return {
        expectation: {
          label: 'strong deterioration',
          expectedRule: 'campaign_efficiency_deterioration',
          expectedAction: 'REDUCE',
          expectedConfidence: 'HIGH',
        },
        comparison,
        current: metrics({
          spend: 140,
          impressions: 12_000,
          reach: 7_000,
          clicks: 240,
          purchases: 7,
          purchaseValue: 280,
        }),
      };
    case 1:
      return {
        expectation: {
          label: 'moderate deterioration',
          expectedRule: 'campaign_efficiency_deterioration',
          expectedAction: 'HOLD',
          expectedConfidence: 'HIGH',
        },
        comparison,
        current: metrics({
          spend: 120,
          impressions: 11_000,
          reach: 7_600,
          clicks: 300,
          purchases: 9,
          purchaseValue: 420,
        }),
      };
    case 2:
      return {
        expectation: {
          label: 'healthy efficiency',
          expectedRule: null,
          expectedAction: null,
          expectedConfidence: null,
        },
        comparison,
        current: metrics({
          spend: 120,
          impressions: 11_000,
          reach: 8_000,
          clicks: 360,
          purchases: 12,
          purchaseValue: 660,
        }),
      };
    default:
      return {
        expectation: {
          label: 'insufficient evidence',
          expectedRule: null,
          expectedAction: null,
          expectedConfidence: null,
        },
        comparison: metrics({
          spend: 10,
          impressions: 800,
          reach: 650,
          clicks: 20,
          purchases: 1,
          purchaseValue: 50,
        }),
        current: metrics({
          spend: 12,
          impressions: 900,
          reach: 680,
          clicks: 18,
          purchases: 1,
          purchaseValue: 45,
        }),
      };
  }
}

function creativeScenario(index: number): {
  expectation: ScenarioExpectation;
  comparison: HistoricalMetrics;
  current: HistoricalMetrics;
} {
  const comparison = metrics({
    spend: 50,
    impressions: 8_000,
    reach: 6_000,
    clicks: 240,
    purchases: 8,
    purchaseValue: 400,
  });

  switch (index % 4) {
    case 0:
      return {
        expectation: {
          label: 'fatigue symptoms',
          expectedRule: 'creative_fatigue_symptoms',
          expectedAction: 'TEST',
          expectedConfidence: 'MEDIUM',
        },
        comparison,
        current: metrics({
          spend: 60,
          impressions: 9_000,
          reach: 4_000,
          clicks: 135,
          purchases: 4,
          purchaseValue: 160,
        }),
      };
    case 1:
      return {
        expectation: {
          label: 'healthy creative',
          expectedRule: null,
          expectedAction: null,
          expectedConfidence: null,
        },
        comparison,
        current: metrics({
          spend: 60,
          impressions: 9_000,
          reach: 6_500,
          clicks: 300,
          purchases: 9,
          purchaseValue: 480,
        }),
      };
    case 2:
      return {
        expectation: {
          label: 'insufficient evidence',
          expectedRule: null,
          expectedAction: null,
          expectedConfidence: null,
        },
        comparison: metrics({
          spend: 6,
          impressions: 800,
          reach: 600,
          clicks: 20,
          purchases: 1,
          purchaseValue: 40,
        }),
        current: metrics({
          spend: 7,
          impressions: 900,
          reach: 500,
          clicks: 17,
          purchases: 1,
          purchaseValue: 35,
        }),
      };
    default:
      return {
        expectation: {
          label: 'frequency up but engagement healthy',
          expectedRule: null,
          expectedAction: null,
          expectedConfidence: null,
        },
        comparison,
        current: metrics({
          spend: 60,
          impressions: 9_000,
          reach: 4_000,
          clicks: 270,
          purchases: 7,
          purchaseValue: 350,
        }),
      };
  }
}

function campaignEvidence(
  campaign: CampaignRow,
  currency: string,
  start: Date,
  end: Date,
  count: number,
  index: number,
): { evidence: CampaignEvidence; expectation: ScenarioExpectation } {
  const scenario = campaignScenario(index);
  return {
    expectation: scenario.expectation,
    evidence: {
      entityId: campaign.id,
      externalEntityId: campaign.id,
      name: campaign.name,
      currency,
      spendShare: 1 / Math.max(count, 1),
      start,
      end,
      comparison: scenario.comparison,
      current: scenario.current,
    },
  };
}

function creativeEvidence(
  ad: AdRow,
  currency: string,
  start: Date,
  end: Date,
  count: number,
  index: number,
): { evidence: CreativeEvidence; expectation: ScenarioExpectation } {
  const scenario = creativeScenario(index);
  return {
    expectation: scenario.expectation,
    evidence: {
      entityId: ad.id,
      externalEntityId: ad.id,
      name: ad.name,
      currency,
      spendShare: 1 / Math.max(count, 1),
      start,
      end,
      comparison: scenario.comparison,
      current: scenario.current,
    },
  };
}

function providerError(path: string, status: number, error?: GraphError): Error {
  const code = [error?.code, error?.error_subcode]
    .filter((value) => value !== undefined)
    .join('/');
  const trace = error?.fbtrace_id ? ` fbtrace_id=${error.fbtrace_id}` : '';
  return new Error(
    `Meta API GET ${path} failed (HTTP ${status}${code ? `, code ${code}` : ''}): ${error?.message ?? 'unknown Meta error'}.${trace}`,
  );
}

async function graph<T>(path: string, params: Record<string, string> = {}): Promise<T> {
  const normalized = path.startsWith('/') ? path : `/${path}`;
  const url = new URL(`https://graph.facebook.com/${apiVersion}${normalized}`);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

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

  if (!response.ok || body?.error) throw providerError(normalized, response.status, body?.error);
  return body as T;
}

async function collect<T extends MetaRecord>(
  path: string,
  params: Record<string, string>,
): Promise<T[]> {
  const rows: T[] = [];
  const seen = new Set<string>();
  let after: string | undefined;

  while (true) {
    const payload = await graph<GraphEnvelope<T> & MetaRecord>(path, {
      ...params,
      ...(after ? { after } : {}),
    });
    rows.push(...(payload.data ?? []));

    const next = payload.paging?.cursors?.after?.trim();
    if (!payload.paging?.next || !next) return rows;
    if (seen.has(next)) throw new Error(`Meta pagination for ${path} repeated cursor ${next}`);
    seen.add(next);
    after = next;
  }
}

function validateScenario(result: EvaluatedScenario): string | null {
  const { recommendation } = result;

  if (result.expectedRule === null) {
    return recommendation === null
      ? null
      : `${result.entityType} ${result.entityId} (${result.label}) expected no recommendation but emitted ${recommendation.ruleId}`;
  }

  if (!recommendation) {
    return `${result.entityType} ${result.entityId} (${result.label}) expected ${result.expectedRule}/${result.expectedAction} but emitted no recommendation`;
  }
  if (recommendation.ruleId !== result.expectedRule) {
    return `${result.entityType} ${result.entityId} (${result.label}) expected rule ${result.expectedRule} but got ${recommendation.ruleId}`;
  }

  const decision = recommendationDecision(recommendation);
  if (decision.decisionAction !== result.expectedAction) {
    return `${result.entityType} ${result.entityId} (${result.label}) expected action ${result.expectedAction} but got ${decision.decisionAction}`;
  }
  if (decision.decisionConfidence !== result.expectedConfidence) {
    return `${result.entityType} ${result.entityId} (${result.label}) expected confidence ${result.expectedConfidence} but got ${decision.decisionConfidence}`;
  }

  return null;
}

function printScenario(index: number, result: EvaluatedScenario): void {
  console.log(`\n#${index + 1} ${result.entityType} · ${result.label}`);
  console.log(`Entity: ${result.entityName} (${result.entityId})`);
  console.log(
    `Expected: ${result.expectedRule ?? 'NO_RECOMMENDATION'}${result.expectedAction ? ` → ${result.expectedAction}` : ''}`,
  );

  if (!result.recommendation) {
    console.log('Actual: NO_RECOMMENDATION');
    console.log('Validation: PASS');
    return;
  }

  const decision = recommendationDecision(result.recommendation);
  console.log(`Rule: ${result.recommendation.ruleId}`);
  console.log(`Severity: ${result.recommendation.severity}`);
  console.log(`Decision action: ${decision.decisionAction}`);
  console.log(`Decision confidence: ${decision.decisionConfidence}`);
  console.log(`Decision basis: ${decision.decisionBasis}`);
  console.log(`Decision message: ${decision.decisionMessage}`);
  console.log(`Raw confidence score: ${result.recommendation.confidenceScore.toFixed(2)}`);
  console.log(`Evidence quality: ${result.recommendation.evidenceQuality}`);
  console.log(`Attribution precision: ${result.recommendation.attributionPrecision}`);
  console.log('Validation: PASS');
}

async function main(): Promise<void> {
  const end = new Date();
  end.setUTCHours(0, 0, 0, 0);
  const start = new Date(end);
  start.setUTCDate(start.getUTCDate() - 13);

  console.log('\nStride Meta sandbox → mixed production-decision validation');
  console.log(`Account: ${accountId}`);
  console.log(`API: ${apiVersion}`);
  console.log('Metrics: deterministic mixed scenarios attached to real sandbox entities');

  console.log('\n[1/4] Validating sandbox token/account and fetching real entities...');
  const [me, account, campaigns, ads] = await Promise.all([
    graph<{ id?: string }>('/me', { fields: 'id' }),
    graph<{ id?: string; name?: string; currency?: string }>(`/${accountId}`, {
      fields: 'id,name,currency',
    }),
    collect<CampaignRow>(`/${accountId}/campaigns`, {
      fields: 'id,name,status,effective_status',
      limit: '100',
    }),
    collect<AdRow>(`/${accountId}/ads`, {
      fields: 'id,name,campaign_id,status,effective_status',
      limit: '500',
    }),
  ]);

  console.log(`Token user: ${me.id ?? 'unknown'}`);
  console.log(`Sandbox account: ${account.name ?? account.id ?? accountId}`);
  console.log(`Campaigns: ${campaigns.length}`);
  console.log(`Ads: ${ads.length}`);

  if (campaigns.length < 4) {
    throw new Error(`Mixed validation requires at least 4 campaigns; sandbox returned ${campaigns.length}.`);
  }
  if (ads.length < 4) {
    throw new Error(`Mixed validation requires at least 4 ads; sandbox returned ${ads.length}.`);
  }

  const currency = currencyOverride || account.currency || 'UNKNOWN';
  const sortedCampaigns = [...campaigns].sort((a, b) => a.id.localeCompare(b.id));
  const sortedAds = [...ads].sort((a, b) => a.id.localeCompare(b.id));
  const evaluated: EvaluatedScenario[] = [];

  console.log('\n[2/4] Running mixed campaign scenarios through production rules + decision mapping...');
  for (const [index, campaign] of sortedCampaigns.entries()) {
    const fixture = campaignEvidence(
      campaign,
      currency,
      start,
      end,
      sortedCampaigns.length,
      index,
    );
    evaluated.push({
      entityType: 'CAMPAIGN',
      entityId: campaign.id,
      entityName: campaign.name,
      ...fixture.expectation,
      recommendation: campaignEfficiencyRule(fixture.evidence),
    });
  }

  console.log('[3/4] Running mixed creative scenarios through production rules + decision mapping...');
  for (const [index, ad] of sortedAds.entries()) {
    const fixture = creativeEvidence(ad, currency, start, end, sortedAds.length, index);
    evaluated.push({
      entityType: 'CREATIVE',
      entityId: ad.id,
      entityName: ad.name,
      ...fixture.expectation,
      recommendation: creativeFatigueRule(fixture.evidence),
    });
  }

  const failures = evaluated
    .map((result) => validateScenario(result))
    .filter((failure): failure is string => failure !== null);

  console.log('\n[4/4] Validation results');
  for (const [index, result] of evaluated.entries()) printScenario(index, result);

  const emitted = evaluated.filter((result) => result.recommendation !== null).length;
  const suppressed = evaluated.length - emitted;
  console.log('\n=== Summary ===');
  console.log(`Scenarios: ${evaluated.length}`);
  console.log(`Recommendations emitted: ${emitted}`);
  console.log(`Correctly suppressed/no-trigger: ${suppressed}`);
  console.log(`Failures: ${failures.length}`);

  if (failures.length > 0) {
    console.error('\n=== FAILURES ===');
    for (const failure of failures) console.error(`- ${failure}`);
    throw new Error(`Mixed sandbox decision validation failed with ${failures.length} mismatch(es).`);
  }

  console.log('\nPASS: mixed positive, negative and insufficient-evidence scenarios matched the expected final DecisionAction and DecisionConfidence.');
  console.log('Note: raw confidenceScore is an internal evidence score, not a calibrated probability of correctness.');
}

main().catch((error) => {
  console.error('\nSandbox decision validation failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
