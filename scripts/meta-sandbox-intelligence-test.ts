/// <reference types="node" />
import 'dotenv/config';

import { env } from '../src/config/env.js';
import { intelligenceService } from '../src/modules/intelligence/intelligence.service.js';
import { metaService } from '../src/modules/meta/meta.service.js';

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

if (env.NODE_ENV !== 'development') {
  throw new Error('Sandbox intelligence test is development-only. Set NODE_ENV=development.');
}

const storeId = required('META_SANDBOX_TEST_STORE_ID');
const lookbackDays = Number(process.env.META_SANDBOX_TEST_LOOKBACK_DAYS ?? '28');

if (!Number.isInteger(lookbackDays) || lookbackDays < 1 || lookbackDays > 90) {
  throw new Error('META_SANDBOX_TEST_LOOKBACK_DAYS must be an integer between 1 and 90');
}

function printJson(label: string, value: unknown) {
  console.log(`\n=== ${label} ===`);
  console.log(JSON.stringify(value, null, 2));
}

async function main() {
  console.log('\nStride Meta sandbox → intelligence end-to-end test');
  console.log(`Store: ${storeId}`);
  console.log(`Meta lookback: ${lookbackDays} days`);

  // The development Meta API context is intentionally routed to the configured sandbox
  // credentials. This also bypasses /me/adaccounts, so no merchant asset picker is involved.
  console.log('\n[1/3] Fetching sandbox account and configuring it locally...');
  const assets = await metaService.discoverAssets(storeId);
  printJson('Sandbox account', assets.adAccounts);

  if (assets.adAccounts.length === 0) {
    throw new Error('Sandbox account was not returned by Meta. Check META_SANDBOX_AD_ACCOUNT_ID.');
  }

  console.log('\n[2/3] Fetching sandbox ads hierarchy + insights from Meta...');
  const sync = await metaService.syncInsights(storeId, lookbackDays);
  printJson('Meta sync result', sync);

  if (sync.recordsWritten === 0) {
    console.warn(
      '\nWARNING: Meta returned no persisted insight rows. The intelligence layer may have no evidence to evaluate.',
    );
  }

  console.log('\n[3/3] Running the intelligence layer against the synced sandbox data...');
  const snapshot = await intelligenceService.snapshot(storeId);

  printJson('Intelligence evidence', snapshot.evidence);
  printJson('Data quality', snapshot.dataQuality);

  console.log('\n=== Recommendations ===');
  if (snapshot.recommendations.length === 0) {
    console.log('No recommendations were emitted for the current sandbox data/window.');
  } else {
    for (const [index, recommendation] of snapshot.recommendations.entries()) {
      console.log(`\n#${index + 1} ${recommendation.title}`);
      console.log(`Rule: ${recommendation.ruleId}`);
      console.log(`Action: ${recommendation.action}`);
      console.log(`Severity: ${recommendation.severity}`);
      console.log(`Priority: ${recommendation.priority.toFixed(4)}`);
      console.log(`Confidence: ${recommendation.confidenceScore.toFixed(2)}`);
      console.log(`Evidence quality: ${recommendation.evidenceQuality}`);
      console.log(`Message: ${recommendation.message}`);
      if (recommendation.limitations.length > 0) {
        console.log(
          `Limitations: ${recommendation.limitations.map((limitation) => limitation.code).join(', ')}`,
        );
      }
    }
  }

  console.log(`\nCompleted. ${snapshot.recommendations.length} recommendation(s) emitted.`);
}

main().catch((error) => {
  console.error('\nSandbox intelligence test failed.');
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
