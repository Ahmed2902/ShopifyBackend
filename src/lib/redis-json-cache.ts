import { env } from '../config/env.js';
import { InFlightCoalescer } from './in-flight-coalescer.js';

type RedisPayload = { result?: unknown; error?: string };
type RedisCommandResult =
  | { ok: true; result: unknown | null }
  | { ok: false; result: null };

const DEFAULT_TIMEOUT_MS = 300;

async function redisCommand(parts: string[], timeoutMs: number): Promise<RedisCommandResult> {
  try {
    const response = await fetch(env.REDIS_REST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(parts),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const payload = (await response.json().catch(() => null)) as RedisPayload | null;
    if (!response.ok || !payload || payload.error) return { ok: false, result: null };
    return { ok: true, result: payload.result ?? null };
  } catch {
    // Analytical caching is an optimization only. Redis failure must never make
    // an otherwise valid database-backed read unavailable.
    return { ok: false, result: null };
  }
}

export class RedisJsonCache {
  constructor(
    private readonly namespace: string,
    private readonly ttlSeconds: number,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
  ) {}

  private key(key: string) {
    return `${this.namespace}:${key}`;
  }

  async get<T>(key: string): Promise<T | null> {
    const command = await redisCommand(['GET', this.key(key)], this.timeoutMs);
    if (!command.ok || typeof command.result !== 'string') return null;
    try {
      return JSON.parse(command.result) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      await redisCommand(
        ['SET', this.key(key), serialized, 'EX', String(this.ttlSeconds)],
        this.timeoutMs,
      );
    } catch {
      // JSON serialization failures or Redis failures must not break the source read.
    }
  }

  async delete(key: string): Promise<void> {
    await redisCommand(['DEL', this.key(key)], this.timeoutMs);
  }

  /**
   * Return the current logical generation for a cache scope.
   *
   * Missing version keys are generation zero. Redis transport failure is different: callers
   * receive null and must bypass caching rather than guessing a generation that could expose an
   * older cached value after an invalidation.
   */
  async getVersion(scope: string): Promise<string | null> {
    const command = await redisCommand(['GET', this.key(`version:${scope}`)], this.timeoutMs);
    if (!command.ok) return null;
    if (command.result === null) return '0';
    if (typeof command.result === 'string' || typeof command.result === 'number') {
      return String(command.result);
    }
    return null;
  }

  /**
   * Advance the logical cache generation. Old values are deliberately left to expire by TTL;
   * they can no longer be read once the version changes, which makes invalidation safe even when
   * an older in-flight loader finishes after the mutation/refresh boundary.
   */
  async incrementVersion(scope: string): Promise<string | null> {
    const command = await redisCommand(['INCR', this.key(`version:${scope}`)], this.timeoutMs);
    if (!command.ok) return null;
    if (typeof command.result === 'string' || typeof command.result === 'number') {
      return String(command.result);
    }
    return null;
  }
}

export class CachedReadCoordinator {
  /** Coalesce the complete read path so simultaneous readers do not duplicate Redis round trips. */
  private readonly reads: InFlightCoalescer;
  /** Coalesce source work across a fresh reader and ordinary readers that resolve to the same version. */
  private readonly sourceReads: InFlightCoalescer;

  constructor(
    private readonly cache: RedisJsonCache,
    maxInFlight = 250,
  ) {
    this.reads = new InFlightCoalescer(maxInFlight);
    this.sourceReads = new InFlightCoalescer(maxInFlight);
  }

  run<T>(
    key: string,
    loader: () => Promise<T>,
    options: { fresh?: boolean; versionScope?: string } = {},
  ): Promise<T> {
    const fresh = options.fresh === true;
    const versionScope = options.versionScope ?? key;
    const operationKey = `${fresh ? 'fresh' : 'read'}:${versionScope}:${key}`;

    // Fresh reads never join an ordinary read that may have started before the refresh boundary.
    // Multiple simultaneous clicks on Refresh do coalesce with each other, so one interaction
    // still produces one generation bump and one source computation.
    return this.reads.run(operationKey, async () => {
      const version = fresh
        ? await this.cache.incrementVersion(versionScope)
        : await this.cache.getVersion(versionScope);

      // Redis/version lookup is fail-open. Do not read or write a guessed generation because a
      // transient version-key failure followed by a successful data GET could resurrect stale data.
      if (version === null) return loader();

      const versionedKey = `v${version}:${key}`;
      if (!fresh) {
        const cached = await this.cache.get<T>(versionedKey);
        if (cached !== null) return cached;
      }

      return this.sourceReads.run(versionedKey, async () => {
        const value = await loader();
        await this.cache.set(versionedKey, value);
        return value;
      });
    });
  }

  /**
   * Versioned invalidation mirrors Systemly's proven analytics-cache model. It is race-safe:
   * an older computation may finish later, but it can only populate the old generation key.
   */
  async invalidate(versionScope: string): Promise<void> {
    await this.cache.incrementVersion(versionScope);
  }
}
