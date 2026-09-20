import { getRequestPerformanceContext } from '../observability/request-performance.js';

/**
 * Coalesce identical source reads for the lifetime of one instrumented HTTP request.
 *
 * The request context owns the storage, but callers depend on this generic read utility rather than
 * on observability internals. Outside an HTTP request the loader runs normally, so workers and tests
 * keep their existing behavior.
 */
export function memoizeRequestRead<T>(key: string, loader: () => Promise<T>): Promise<T> {
  const context = getRequestPerformanceContext();
  if (!context) return loader();

  const existing = context.memoizedReads.get(key);
  if (existing) return existing as Promise<T>;

  const pending = loader();
  context.memoizedReads.set(key, pending as Promise<unknown>);
  pending.catch(() => {
    if (context.memoizedReads.get(key) === pending) context.memoizedReads.delete(key);
  });
  return pending;
}
