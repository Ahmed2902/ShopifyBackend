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
  console.log('\nStride Meta sandbox → intelligence test');
  console.log(`Store: ${storeId}`);
  console.log(`Meta lookback: ${lookbackDays} days`);
  console.log(`Sandbox account: ${env.META_SANDBOX_AD_ACCOUNT_ID}`);

  // The purpose of this script is to exercise the real intelligence layer against
  // the sandbox account. We deliberately use the normal application sync path so
  // the same Meta → DB normalization used by production is tested.
  //
  // In development getApiContext() forces the configured sandbox token/account,
  // so no merchant account selection is required.
  console.log('\n[1/3] Syncing sandbox campaigns, ads and hierarchy...');
  const hierarchy = await metaService.syncAdsHierarchy(storeId);
  printJson('Sandbox hierarchy sync', hierarchy);

  console.log('\n[2/3] Syncing sandbox insights...');
  const sync = await metaService.syncInsights(storeId, lookbackDays);
  printJson('Sandbox insights sync', sync);

  console.log('\n[3/3] Running the existing intelligence equations against synced sandbox data...');
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
