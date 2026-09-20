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

type LocalPayload = { version: string; value: unknown; expiresAtMs: number };

const DEFAULT_TIMEOUT_MS = 300;
const DEFAULT_LOCAL_PAYLOAD_MAX_ENTRIES = 128;
const VERSIONED_GET_SCRIPT = [
  "local version = redis.call('GET', KEYS[1]) or '0'",
  "local known = ARGV[3] or ''",
  "if known == tostring(version) then return { tostring(version), 1, '' } end",
  "local value = redis.call('GET', ARGV[1] .. version .. ':' .. ARGV[2]) or ''",
  "return { tostring(version), 0, value }",
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
  private readonly localPayloads = new Map<string, LocalPayload>();

  constructor(
    private readonly namespace: string,
    private readonly ttlSeconds: number,
    private readonly timeoutMs = DEFAULT_TIMEOUT_MS,
    private readonly localPayloadMaxEntries = DEFAULT_LOCAL_PAYLOAD_MAX_ENTRIES,
  ) {}

  private key(key: string) {
    return `${this.namespace}:${key}`;
  }

  private localKey(scope: string, key: string): string {
    return `${scope}\u0000${key}`;
  }

  private currentLocalPayload(scope: string, key: string): LocalPayload | null {
    const localKey = this.localKey(scope, key);
    const payload = this.localPayloads.get(localKey);
    if (!payload) return null;
    if (payload.expiresAtMs <= Date.now()) {
      this.localPayloads.delete(localKey);
      return null;
    }
    return payload;
  }

  rememberVersioned<T>(scope: string, key: string, version: string, value: T): void {
    if (this.localPayloadMaxEntries <= 0) return;
    const localKey = this.localKey(scope, key);
    this.localPayloads.delete(localKey);
    this.localPayloads.set(localKey, {
      version,
      value,
      expiresAtMs: Date.now() + this.ttlSeconds * 1_000,
    });
    while (this.localPayloads.size > this.localPayloadMaxEntries) {
      const oldest = this.localPayloads.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.localPayloads.delete(oldest);
    }
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

  /**
   * Redis remains authoritative for the generation on every read. When the local process already
   * holds an unexpired payload for that exact generation, Redis returns only a tiny version-match
   * marker. Local reuse never extends beyond the shared Redis TTL, so TTL expiry remains a fallback
   * freshness boundary even if an invalidation hook is missed.
   */
  async getVersioned<T>(scope: string, key: string): Promise<VersionedRead<T> | null> {
    const localKey = this.localKey(scope, key);
    const local = this.currentLocalPayload(scope, key);
    const knownVersion = local?.version ?? '';

    const command = await redisCommand(
      [
        'EVAL',
        VERSIONED_GET_SCRIPT,
        '1',
        this.key(`version:${scope}`),
        `${this.namespace}:v`,
        key,
        knownVersion,
      ],
      this.timeoutMs,
    );
    if (!command.ok || !Array.isArray(command.result) || command.result.length !== 3) return null;

    const [rawVersion, rawLocalHit, rawValue] = command.result;
    if (typeof rawVersion !== 'string' && typeof rawVersion !== 'number') return null;
    const version = String(rawVersion);

    if ((rawLocalHit === 1 || rawLocalHit === '1') && local?.version === version) {
      this.localPayloads.delete(localKey);
      this.localPayloads.set(localKey, local);
      recordRequestPerformanceSpan('redis.local_payload_hit', 0);
      return { version, value: local.value as T };
    }

    recordRequestPerformanceSpan('redis.local_payload_miss', 0);
    if (typeof rawValue !== 'string' || rawValue.length === 0) return { version, value: null };
    try {
      const value = JSON.parse(rawValue) as T;
      this.rememberVersioned(scope, key, version, value);
      return { version, value };
    } catch {
      return { version, value: null };
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

    return this.reads.run(operationKey, async () => {
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
        return this.sourceReads.run(versionedKey, async () => {
          const value = await loader();
          await this.cache.set(versionedKey, value);
          this.cache.rememberVersioned(versionScope, key, resolved.version, value);
          return value;
        });
      }

      recordCacheOutcome('fresh');
      const version = await this.cache.incrementVersion(versionScope);
      if (version === null) {
        recordCacheOutcome('error');
        return loader();
      }

      const versionedKey = `v${version}:${key}`;
      return this.sourceReads.run(versionedKey, async () => {
        const value = await loader();
        await this.cache.set(versionedKey, value);
        this.cache.rememberVersioned(versionScope, key, version, value);
        return value;
      });
    });
  }

  async invalidate(versionScope: string): Promise<void> {
    await this.cache.incrementVersion(versionScope);
  }
}
