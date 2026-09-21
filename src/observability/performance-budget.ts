export interface PerformanceBudget {
  name: string;
  maxDurationMs: number;
  maxPrismaQueries: number;
}

const STORE_PREFIX = /^\/v1\/stores\/[^/]+/;

function normalizedPath(path: string): string {
  return path.replace(STORE_PREFIX, '/v1/stores/:storeId');
}

/**
 * These are cold/source-path ceilings, not promises about every internet hop. Warm generation-cache
 * reads should normally be materially faster. The request logger reports violations so query or
 * orchestration regressions are visible before a 3-8 second endpoint becomes normal again.
 */
export function resolvePerformanceBudget(method: string, rawPath: string): PerformanceBudget | null {
  if (method.toUpperCase() !== 'GET') return null;
  const path = normalizedPath(rawPath.split('?', 1)[0] ?? rawPath);

  if (path === '/v1/stores/:storeId/analytics/dashboard') {
    return { name: 'analytics.dashboard', maxDurationMs: 1_200, maxPrismaQueries: 12 };
  }
  if (path === '/v1/stores/:storeId/intelligence/snapshot') {
    return { name: 'intelligence.snapshot', maxDurationMs: 1_500, maxPrismaQueries: 12 };
  }
  if (
    /^\/v1\/stores\/:storeId\/analytics\/(overview|advertising|report|performance)$/.test(path)
  ) {
    return { name: 'analytics.heavy', maxDurationMs: 900, maxPrismaQueries: 9 };
  }
  if (
    /^\/v1\/stores\/:storeId\/analytics\/(products|product-ads|collections|customers|inventory|campaigns|adsets|ads|creatives)$/.test(
      path,
    )
  ) {
    return { name: 'analytics.list', maxDurationMs: 700, maxPrismaQueries: 6 };
  }
  if (
    /^\/v1\/stores\/:storeId\/analytics\/(products|product-ads|collections|campaigns|adsets|ads|creatives)\/[^/]+$/.test(
      path,
    )
  ) {
    return { name: 'analytics.detail', maxDurationMs: 800, maxPrismaQueries: 8 };
  }
  if (path === '/v1/stores/:storeId/analytics/tiktok-monitor') {
    return { name: 'analytics.tiktok-monitor', maxDurationMs: 900, maxPrismaQueries: 8 };
  }

  return null;
}
