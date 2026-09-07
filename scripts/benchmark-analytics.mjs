const baseUrl = (process.env.BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const storeId = process.env.STORE_ID;
const accessToken = process.env.ACCESS_TOKEN;
const iterations = Number.parseInt(process.env.BENCHMARK_ITERATIONS ?? '20', 10);
const warmups = Number.parseInt(process.env.BENCHMARK_WARMUPS ?? '3', 10);
const timeoutMs = Number.parseInt(process.env.BENCHMARK_TIMEOUT_MS ?? '30000', 10);

if (!storeId) throw new Error('STORE_ID is required');
if (!accessToken) throw new Error('ACCESS_TOKEN is required');
if (!Number.isInteger(iterations) || iterations < 1) throw new Error('BENCHMARK_ITERATIONS must be >= 1');
if (!Number.isInteger(warmups) || warmups < 0) throw new Error('BENCHMARK_WARMUPS must be >= 0');

const headers = { Authorization: `Bearer ${accessToken}` };

const cases = [
  {
    name: 'dashboard warm-cache read',
    path: `/v1/stores/${encodeURIComponent(storeId)}/analytics/dashboard?days=30`,
  },
  {
    name: 'dashboard forced refresh',
    path: `/v1/stores/${encodeURIComponent(storeId)}/analytics/dashboard?days=30&fresh=true`,
  },
  {
    name: 'advertising overview',
    path: `/v1/stores/${encodeURIComponent(storeId)}/analytics/advertising?days=30`,
  },
  {
    name: 'intelligence warm-cache read',
    path: `/v1/stores/${encodeURIComponent(storeId)}/intelligence/snapshot`,
  },
  {
    name: 'intelligence forced refresh',
    path: `/v1/stores/${encodeURIComponent(storeId)}/intelligence/snapshot?fresh=true`,
  },
  {
    name: 'tiktok monitor warm-cache page',
    path: `/v1/stores/${encodeURIComponent(storeId)}/analytics/tiktok-monitor?days=30&level=campaigns&page=1&limit=50`,
  },
  {
    name: 'tiktok monitor forced refresh page',
    path: `/v1/stores/${encodeURIComponent(storeId)}/analytics/tiktok-monitor?days=30&level=campaigns&page=1&limit=50&fresh=true`,
  },
];

function percentile(sorted, quantile) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * quantile) - 1);
  return sorted[index];
}

function round(value) {
  return Math.round(value * 10) / 10;
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

async function benchmark(testCase) {
  for (let index = 0; index < warmups; index += 1) await sample(testCase.path);

  const samples = [];
  for (let index = 0; index < iterations; index += 1) {
    samples.push(await sample(testCase.path));
  }

  const durations = samples.map((item) => item.durationMs).sort((a, b) => a - b);
  const sizes = samples.map((item) => item.bytes).sort((a, b) => a - b);
  return {
    endpoint: testCase.name,
    iterations,
    minMs: round(durations[0]),
    medianMs: round(percentile(durations, 0.5)),
    p95Ms: round(percentile(durations, 0.95)),
    maxMs: round(durations.at(-1)),
    medianBytes: percentile(sizes, 0.5),
    maxBytes: sizes.at(-1),
  };
}

console.log(`Analytics benchmark: ${baseUrl} · store ${storeId} · ${iterations} measured / ${warmups} warmup`);
const results = [];
for (const testCase of cases) {
  process.stdout.write(`- ${testCase.name} ... `);
  try {
    const result = await benchmark(testCase);
    results.push(result);
    console.log(`p95 ${result.p95Ms} ms, median ${result.medianMs} ms, ${result.medianBytes} B`);
  } catch (error) {
    console.log('FAILED');
    throw error;
  }
}

console.table(results);
console.log('\nInterpretation:');
console.log('- warm-cache cases measure normal unchanged-store reads');
console.log('- forced-refresh cases advance the relevant cache generation and measure source-query recomputation');
console.log('- advertising overview is currently uncached and therefore measures the compact SQL read directly');
console.log('- TikTok monitor measures one bounded hierarchy page; cost should stay independent of total advertiser history');
console.log('- pair these numbers with LOG_REQUEST_PERFORMANCE=true to inspect DB query count/wall time');
