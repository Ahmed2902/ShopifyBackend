import { env } from '../config/env.js';
import { InFlightCoalescer } from './in-flight-coalescer.js';

type RedisPayload = { result?: unknown; error?: string };

const DEFAULT_TIMEOUT_MS = 2_000;

async function redisCommand(parts: string[]): Promise<unknown | null> {
  try {
    const response = await fetch(env.REDIS_REST_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.REDIS_REST_TOKEN}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(parts),
      signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
    });
    const payload = (await response.json().catch(() => null)) as RedisPayload | null;
    if (!response.ok || !payload || payload.error) return null;
    return payload.result ?? null;
  } catch {
    // Analytical caching is an optimization only. Redis failure must never make
    // an otherwise valid database-backed read unavailable.
    return null;
  }
}

export class RedisJsonCache {
  constructor(
    private readonly namespace: string,
    private readonly ttlSeconds: number,
  ) {}

  private key(key: string) {
    return `${this.namespace}:${key}`;
  }

  async get<T>(key: string): Promise<T | null> {
    const value = await redisCommand(['GET', this.key(key)]);
    if (typeof value !== 'string') return null;
    try {
      return JSON.parse(value) as T;
    } catch {
      return null;
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    try {
      const serialized = JSON.stringify(value);
      await redisCommand(['SET', this.key(key), serialized, 'EX', String(this.ttlSeconds)]);
    } catch {
      // JSON serialization failures or Redis failures must not break the source read.
    }
  }

  async delete(key: string): Promise<void> {
    await redisCommand(['DEL', this.key(key)]);
  }
}

export class CachedReadCoordinator {
  private readonly inFlight: InFlightCoalescer;

  constructor(
    private readonly cache: RedisJsonCache,
    maxInFlight = 250,
  ) {
    this.inFlight = new InFlightCoalescer(maxInFlight);
  }

  async run<T>(
    key: string,
    loader: () => Promise<T>,
    options: { fresh?: boolean } = {},
  ): Promise<T> {
    const fresh = options.fresh === true;
    if (!fresh) {
      const cached = await this.cache.get<T>(key);
      if (cached !== null) return cached;
    }

    // Fresh and ordinary reads intentionally share the same in-flight key. A
    // cache miss already performed the one useful Redis lookup before this
    // point; repeating GET inside the coalesced loader only adds a remote round
    // trip. If another request is already computing the same key, the coalescer
    // reuses that source result directly.
    return this.inFlight.run(key, async () => {
      const value = await loader();
      await this.cache.set(key, value);
      return value;
    });
  }

  invalidate(key: string): Promise<void> {
    return this.cache.delete(key);
  }
}
