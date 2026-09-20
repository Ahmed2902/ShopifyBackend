import { performance } from 'node:perf_hooks';
import { env } from '../config/env.js';
import {
  recordCacheOutcome,
  recordRequestPerformanceSpan,
} from '../observability/request-performance.js';
import { InFlightCoalescer } from './in-flight-coalescer.js';

type RedisPayload = { result?: unknown; error?: string };
type RedisCommandResult =
  | { ok: true; result: unknown | null }
  | { ok: false; result: null };

type VersionedRead<T> = {
  version: string;
  value: T | null;
};

const DEFAULT_TIMEOUT_MS = 300;
const VERSIONED_GET_SCRIPT = [
  "local version = redis.call('GET', KEYS[1]) or '0'",
  "local value = redis.call('GET', ARGV[1] .. version .. ':' .. ARGV[2])",
  'return { tostring(version), value }',
].join('\n');

async function redisCommand(parts: string[], timeoutMs: number): Promise<RedisCommandResult> {
  const startedAt = performance.now();
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
    return { ok: false, result: null };
  } finally {
    recordRequestPerformanceSpan('redis.http', performance.now() - startedAt);
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

  async getVersioned<T>(scope: string, key: string): Promise<VersionedRead<T> | null> {
    const command = await redisCommand(
      [
        'EVAL',
        VERSIONED_GET_SCRIPT,
        '1',
        this.key(`version:${scope}`),
        `${this.namespace}:v`,
        key,
      ],
      this.timeoutMs,
    );
    if (!command.ok || !Array.isArray(command.result) || command.result.length !== 2) return null;

    const [rawVersion, rawValue] = command.result;
    if (typeof rawVersion !== 'string' && typeof rawVersion !== 'number') return null;
    if (rawValue !== null && typeof rawValue !== 'string') return null;

    if (rawValue === null) return { version: String(rawVersion), value: null };
    try {
      return { version: String(rawVersion), value: JSON.parse(rawValue) as T };
    } catch {
      return { version: String(rawVersion), value: null };
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
      // Cache writes are fail-open; source truth has already been computed.
    }
  }

  async delete(key: string): Promise<void> {
    await redisCommand(['DEL', this.key(key)], this.timeoutMs);
  }

  async getVersion(scope: string): Promise<string | null> {
    const command = await redisCommand(['GET', this.key(`version:${scope}`)], this.timeoutMs);
    if (!command.ok) return null;
    if (command.result === null) return '0';
    if (typeof command.result === 'string' || typeof command.result === 'number') {
      return String(command.result);
    }
    return null;
  }

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
  private readonly reads: InFlightCoalescer;
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

    return this.reads.run(
      operationKey,
      async () => {
        if (!fresh) {
          const resolved = await this.cache.getVersioned<T>(versionScope, key);
          if (resolved === null) {
            recordCacheOutcome('error');
            return loader();
          }
          if (resolved.value !== null) {
            recordCacheOutcome('hit');
            return resolved.value;
          }
          recordCacheOutcome('miss');

          const versionedKey = `v${resolved.version}:${key}`;
          return this.sourceReads.run(
            versionedKey,
            async () => {
              const value = await loader();
              await this.cache.set(versionedKey, value);
              return value;
            },
            { onJoin: () => recordCacheOutcome('coalesced') },
          );
        }

        recordCacheOutcome('fresh');
        const version = await this.cache.incrementVersion(versionScope);
        if (version === null) {
          recordCacheOutcome('error');
          return loader();
        }

        const versionedKey = `v${version}:${key}`;
        return this.sourceReads.run(
          versionedKey,
          async () => {
            const value = await loader();
            await this.cache.set(versionedKey, value);
            return value;
          },
          { onJoin: () => recordCacheOutcome('coalesced') },
        );
      },
      { onJoin: () => recordCacheOutcome('coalesced') },
    );
  }

  async invalidate(versionScope: string): Promise<void> {
    await this.cache.incrementVersion(versionScope);
  }
}
