# Performance acceptance contract

Stride treats latency and database fan-out as release-quality constraints, not post-release diagnostics.

## Local/production-like benchmark

Run:

```bash
STORE_ID=<store-id> ACCESS_TOKEN=<token> npm run perf:analytics
```

Useful controls:

- `BASE_URL` — API origin (defaults to `http://localhost:3001`)
- `BENCHMARK_ITERATIONS` — measured sequential samples
- `BENCHMARK_WARMUPS` — warm-up samples
- `BENCHMARK_CONCURRENCY` — concurrent samples for tail/throughput measurement
- `BENCHMARK_ENFORCE_BUDGETS=true` — fail if an endpoint exceeds its configured p95 budget
- `BENCHMARK_JSON_PATH=<path>` — persist machine-readable results for before/after comparison

The suite covers warm and source-recompute paths for the dashboard, overview, commerce lists, product×ads, inventory, paid-media lists, report, intelligence snapshot, and TikTok monitor.

## Request budgets

Analytical GET routes have explicit total-duration and Prisma-query ceilings. Request telemetry reports:

- total duration
- Prisma query count
- cumulative Prisma duration
- actual overlapping-query DB wall time
- non-database duration
- named spans such as Redis HTTP
- cache hit/miss/fresh/error outcomes
- whether the route exceeded its duration or query budget

A budget breach emits `performance_budget_exceeded` even when the functional response succeeds.

## Target envelope

The default benchmark targets are intentionally strict enough to catch a return to multi-second reads:

- warm cached core reads: p95 <= 300 ms
- source dashboard: p95 <= 1.2 s
- source intelligence snapshot: p95 <= 1.5 s
- heavy source analytics: p95 <= 900 ms
- ordinary source list reads: p95 <= 700 ms

These are acceptance targets for production-like data, not promises that CI's empty/local database proves production latency. Always pair benchmark results with request telemetry and investigate DB vs non-DB time before changing indexes or cache policy.
