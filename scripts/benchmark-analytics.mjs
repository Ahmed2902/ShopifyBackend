import { writeFile } from 'node:fs/promises';

const baseUrl = (process.env.BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const storeId = process.env.STORE_ID;
const accessToken = process.env.ACCESS_TOKEN;
const iterations = Number.parseInt(process.env.BENCHMARK_ITERATIONS ?? '20', 10);
const warmups = Number.parseInt(process.env.BENCHMARK_WARMUPS ?? '3', 10);
const configuredConcurrency = Number.parseInt(process.env.BENCHMARK_CONCURRENCY ?? '5', 10);
const timeoutMs = Number.parseInt(process.env.BENCHMARK_TIMEOUT_MS ?? '30000', 10);
const enforceBudgets = process.env.BENCHMARK_ENFORCE_BUDGETS === 'true';
const jsonPath = process.env.BENCHMARK_JSON_PATH;

if (!storeId) throw new Error('STORE_ID is required');
if (!accessToken) throw new Error('ACCESS_TOKEN is required');
if (!Number.isInteger(iterations) || iterations < 1) throw new Error('BENCHMARK_ITERATIONS must be >= 1');
if (!Number.isInteger(warmups) || warmups < 0) throw new Error('BENCHMARK_WARMUPS must be >= 0');
if (!Number.isInteger(configuredConcurrency) || configuredConcurrency < 1) throw new Error('BENCHMARK_CONCURRENCY must be >= 1');

const effectiveConcurrency = Math.min(configuredConcurrency, iterations);
const headers = { Authorization: `Bearer ${accessToken}` };
const store = encodeURIComponent(storeId);
const warmBudget = 300;
const listSourceBudget = 700;
const heavySourceBudget = 900;

const cases = [
  { name: 'dashboard warm', path: `/v1/stores/${store}/analytics/dashboard?days=30`, p95BudgetMs: warmBudget, concurrent: true },
  { name: 'dashboard source', path: `/v1/stores/${store}/analytics/dashboard?days=30&fresh=true`, p95BudgetMs: 1_200 },
  { name: 'overview warm', path: `/v1/stores/${store}/analytics/overview?days=30`, p95BudgetMs: warmBudget, concurrent: true },
  { name: 'overview source', path: `/v1/stores/${store}/analytics/overview?days=30&fresh=true`, p95BudgetMs: heavySourceBudget },
  { name: 'products warm', path: `/v1/stores/${store}/analytics/products?days=30&page=1&limit=50`, p95BudgetMs: warmBudget, concurrent: true },
  { name: 'products source', path: `/v1/stores/${store}/analytics/products?days=30&page=1&limit=50&fresh=true`, p95BudgetMs: listSourceBudget },
  { name: 'product ads warm', path: `/v1/stores/${store}/analytics/product-ads?days=30&page=1&limit=50`, p95BudgetMs: warmBudget, concurrent: true },
  { name: 'product ads source', path: `/v1/stores/${store}/analytics/product-ads?days=30&page=1&limit=50&fresh=true`, p95BudgetMs: listSourceBudget },
  { name: 'collections warm', path: `/v1/stores/${store}/analytics/collections?days=30&page=1&limit=50`, p95BudgetMs: warmBudget, concurrent: true },
  { name: 'collections source', path: `/v1/stores/${store}/analytics/collections?days=30&page=1&limit=50&fresh=true`, p95BudgetMs: listSourceBudget },
  { name: 'customers warm', path: `/v1/stores/${store}/analytics/customers?days=30`, p95BudgetMs: warmBudget, concurrent: true },
  { name: 'customers source', path: `/v1/stores/${store}/analytics/customers?days=30&fresh=true`, p95BudgetMs: heavySourceBudget },
  { name: 'inventory warm', path: `/v1/stores/${store}/analytics/inventory?days=30&page=1&limit=50`, p95BudgetMs: warmBudget, concurrent: true },
  { name: 'inventory source', path: `/v1/stores/${store}/analytics/inventory?days=30&page=1&limit=50&fresh=true`, p95BudgetMs: listSourceBudget },
  { name: 'advertising warm', path: `/v1/stores/${store}/analytics/advertising?days=30`, p95BudgetMs: warmBudget, concurrent: true },
  { name: 'advertising source', path: `/v1/stores/${store}/analytics/advertising?days=30&fresh=true`, p95BudgetMs: heavySourceBudget },
  { name: 'campaigns warm', path: `/v1/stores/${store}/analytics/campaigns?days=30&page=1&limit=50`, p95BudgetMs: warmBudget, concurrent: true },
  { name: 'campaigns source', path: `/v1/stores/${store}/analytics/campaigns?days=30&page=1&limit=50&fresh=true`, p95BudgetMs: listSourceBudget },
  { name: 'ad sets warm', path: `/v1/stores/${store}/analytics/adsets?days=30&page=1&limit=50`, p95BudgetMs: warmBudget, concurrent: true },
  { name: 'ad sets source', path: `/v1/stores/${store}/analytics/adsets?days=30&page=1&limit=50&fresh=true`, p95BudgetMs: listSourceBudget },
  { name: 'ads warm', path: `/v1/stores/${store}/analytics/ads?days=30&page=1&limit=50`, p95BudgetMs: warmBudget, concurrent: true },
  { name: 'ads source', path: `/v1/stores/${store}/analytics/ads?days=30&page=1&limit=50&fresh=true`, p95BudgetMs: listSourceBudget },
  { name: 'creatives warm', path: `/v1/stores/${store}/analytics/creatives?days=30&page=1&limit=50`, p95BudgetMs: warmBudget, concurrent: true },
  { name: 'creatives source', path: `/v1/stores/${store}/analytics/creatives?days=30&page=1&limit=50&fresh=true`, p95BudgetMs: listSourceBudget },
  { name: 'report warm', path: `/v1/stores/${store}/analytics/report?days=30`, p95BudgetMs: warmBudget, concurrent: true },
  { name: 'report source', path: `/v1/stores/${store}/analytics/report?days=30&fresh=true`, p95BudgetMs: heavySourceBudget },
  { name: 'intelligence warm', path: `/v1/stores/${store}/intelligence/snapshot`, p95BudgetMs: warmBudget, concurrent: true },
  { name: 'intelligence source', path: `/v1/stores/${store}/intelligence/snapshot?fresh=true`, p95BudgetMs: 1_500 },
  { name: 'tiktok monitor warm', path: `/v1/stores/${store}/analytics/tiktok-monitor?days=30&level=campaigns&page=1&limit=50`, p95BudgetMs: 400, concurrent: true },
  { name: 'tiktok monitor source', path: `/v1/stores/${store}/analytics/tiktok-monitor?days=30&level=campaigns&page=1&limit=50&fresh=true`, p95BudgetMs: heavySourceBudget },
];

function percentile(sorted, quantile) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index];
}

function round(value) {
  return Math.round(value * 10) / 10;
}

function summarize(samples) {
  const durations = samples.map((item) => item.durationMs).sort((a, b) => a - b);
  const sizes = samples.map((item) => item.bytes).sort((a, b) => a - b);
  return {
    minMs: round(durations[0]),
    p50Ms: round(percentile(durations, 0.5)),
    p95Ms: round(percentile(durations, 0.95)),
    p99Ms: round(percentile(durations, 0.99)),
    maxMs: round(durations.at(-1)),
    medianBytes: percentile(sizes, 0.5),
    maxBytes: sizes.at(-1),
  };
}

async function sample(path) {
  const startedAt = performance.now();
  const response = await fetch(`${baseUrl}${path}`, {
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });
  const body = await response.arrayBuffer();
  const durationMs = performance.now() - startedAt;

  if (!response.ok) {
    const preview = new TextDecoder().decode(body.slice(0, 500));
    throw new Error(`${response.status} ${response.statusText}: ${preview}`);
  }

  return {
    durationMs,
    bytes: body.byteLength,
    requestId: response.headers.get('x-request-id'),
  };
}

async function benchmarkSequential(testCase) {
  for (let index = 0; index < warmups; index += 1) await sample(testCase.path);
  const samples = [];
  for (let index = 0; index < iterations; index += 1) samples.push(await sample(testCase.path));
  return summarize(samples);
}

async function benchmarkConcurrent(testCase) {
  const samples = [];
  let next = 0;
  const startedAt = performance.now();
  const workers = Array.from({ length: effectiveConcurrency }, async () => {
    while (true) {
      const index = next;
      next += 1;
      if (index >= iterations) return;
      samples.push(await sample(testCase.path));
    }
  });
  await Promise.all(workers);
  const elapsedMs = performance.now() - startedAt;
  return {
    ...summarize(samples),
    concurrency: effectiveConcurrency,
    throughputRps: round((samples.length * 1_000) / elapsedMs),
  };
}

console.log(
  `Analytics benchmark v2: ${baseUrl} · store ${storeId} · ${iterations} measured / ${warmups} warmup · concurrency ${effectiveConcurrency}${effectiveConcurrency !== configuredConcurrency ? ` (configured ${configuredConcurrency})` : ''}`,
);
const results = [];
const violations = [];
for (const testCase of cases) {
  process.stdout.write(`- ${testCase.name} ... `);
  try {
    const sequential = await benchmarkSequential(testCase);
    const concurrentResult = testCase.concurrent ? await benchmarkConcurrent(testCase) : null;
    const budgetPassed = sequential.p95Ms <= testCase.p95BudgetMs;
    const result = {
      endpoint: testCase.name,
      iterations,
      p95BudgetMs: testCase.p95BudgetMs,
      budgetPassed,
      ...sequential,
      concurrentWorkers: concurrentResult?.concurrency ?? null,
      concurrentP95Ms: concurrentResult?.p95Ms ?? null,
      concurrentP99Ms: concurrentResult?.p99Ms ?? null,
      throughputRps: concurrentResult?.throughputRps ?? null,
    };
    results.push(result);
    if (!budgetPassed) violations.push(result);
    console.log(
      `p50 ${result.p50Ms} ms · p95 ${result.p95Ms} ms · p99 ${result.p99Ms} ms · budget ${budgetPassed ? 'OK' : 'FAIL'}`,
    );
  } catch (error) {
    console.log('FAILED');
    throw error;
  }
}

console.table(results);

if (jsonPath) {
  await writeFile(
    jsonPath,
    `${JSON.stringify({ generatedAt: new Date().toISOString(), baseUrl, storeId, iterations, warmups, configuredConcurrency, effectiveConcurrency, results }, null, 2)}\n`,
    'utf8',
  );
  console.log(`Wrote benchmark JSON to ${jsonPath}`);
}

console.log('\nInterpretation:');
console.log('- warm cases measure the normal unchanged-store read path and should mostly hit generation caches');
console.log('- source cases use fresh=true to advance the generation and measure source-query recomputation');
console.log('- p50/p95/p99 expose tail latency; concurrent warm cases also report throughput and concurrent tail latency');
console.log('- run with LOG_REQUEST_PERFORMANCE=true to correlate HTTP latency with DB wall time, Redis/provider spans, cache outcomes and query budgets');
console.log('- BENCHMARK_ENFORCE_BUDGETS=true makes any sequential p95 budget violation fail the command');

if (violations.length > 0) {
  console.error(`\n${violations.length} performance budget violation(s):`);
  for (const violation of violations) {
    console.error(`- ${violation.endpoint}: p95 ${violation.p95Ms} ms > ${violation.p95BudgetMs} ms`);
  }
  if (enforceBudgets) process.exitCode = 1;
}
