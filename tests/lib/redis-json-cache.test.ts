import { afterEach, describe, expect, it, vi } from 'vitest';
import { CachedReadCoordinator, RedisJsonCache } from '../../src/lib/redis-json-cache.js';

function redisResponse(result: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify({ result }), {
      status,
      headers: { 'content-type': 'application/json' },
    }),
  );
}

function installRedisMock(initial: Record<string, string> = {}) {
  const values = new Map(Object.entries(initial));
  const commands: string[][] = [];
  const fetchMock = vi.fn().mockImplementation((_, init?: RequestInit) => {
    const command = JSON.parse(String(init?.body)) as string[];
    commands.push(command);
    const [name, key] = command;

    if (name === 'GET') return redisResponse(values.get(key!) ?? null);
    if (name === 'EVAL') {
      const versionKey = command[3]!;
      const valuePrefix = command[4]!;
      const logicalKey = command[5]!;
      const knownVersion = command[6] ?? '';
      const version = values.get(versionKey) ?? '0';
      const localHit = knownVersion === version;
      return redisResponse([
        version,
        localHit ? 1 : 0,
        localHit ? '' : (values.get(`${valuePrefix}${version}:${logicalKey}`) ?? ''),
      ]);
    }
    if (name === 'SET') {
      values.set(key!, command[2]!);
      return redisResponse('OK');
    }
    if (name === 'DEL') {
      const existed = values.delete(key!);
      return redisResponse(existed ? 1 : 0);
    }
    if (name === 'INCR') {
      const next = Number(values.get(key!) ?? '0') + 1;
      values.set(key!, String(next));
      return redisResponse(next);
    }
    return redisResponse(null);
  });
  vi.stubGlobal('fetch', fetchMock);
  return { values, commands, fetchMock };
}

describe('RedisJsonCache / CachedReadCoordinator', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns a versioned cached value with one Redis REST round trip', async () => {
    const redis = installRedisMock({
      'test-cache:v0:store:overview': JSON.stringify({ value: 42 }),
    });
    const coordinator = new CachedReadCoordinator(new RedisJsonCache('test-cache', 30));
    const loader = vi.fn().mockResolvedValue({ value: 99 });

    await expect(coordinator.run('store:overview', loader)).resolves.toEqual({ value: 42 });

    expect(loader).not.toHaveBeenCalled();
    expect(redis.commands).toHaveLength(1);
    expect(redis.commands[0]?.[0]).toBe('EVAL');
    expect(redis.commands[0]?.slice(2)).toEqual([
      '1',
      'test-cache:version:store:overview',
      'test-cache:v',
      'store:overview',
      '',
    ]);
  });

  it('checks Redis generation but avoids retransmitting an unchanged local payload', async () => {
    const redis = installRedisMock({
      'test-cache:v0:store:overview': JSON.stringify({ value: 42, large: 'x'.repeat(1000) }),
    });
    const coordinator = new CachedReadCoordinator(new RedisJsonCache('test-cache', 30));
    const loader = vi.fn().mockResolvedValue({ value: 99 });

    const first = await coordinator.run('store:overview', loader);
    const second = await coordinator.run('store:overview', loader);

    expect(second).toEqual(first);
    expect(loader).not.toHaveBeenCalled();
    expect(redis.commands).toHaveLength(2);
    expect(redis.commands[1]?.[0]).toBe('EVAL');
    expect(redis.commands[1]?.[6]).toBe('0');
  });

  it('does not let the local payload extend reuse beyond the Redis TTL', async () => {
    let now = 1_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now);
    const redis = installRedisMock({
      'test-cache:v0:store:overview': JSON.stringify({ value: 1 }),
    });
    const coordinator = new CachedReadCoordinator(new RedisJsonCache('test-cache', 1));
    const loader = vi.fn().mockResolvedValue({ value: 2 });

    await expect(coordinator.run('store:overview', loader)).resolves.toEqual({ value: 1 });
    now += 1_001;
    redis.values.delete('test-cache:v0:store:overview');

    await expect(coordinator.run('store:overview', loader)).resolves.toEqual({ value: 2 });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(redis.commands[1]?.[0]).toBe('EVAL');
    expect(redis.commands[1]?.[6]).toBe('');
  });

  it('never serves a local payload after another process advances the generation', async () => {
    const redis = installRedisMock({
      'test-cache:v0:store:overview': JSON.stringify({ value: 1 }),
    });
    const coordinator = new CachedReadCoordinator(new RedisJsonCache('test-cache', 30));
    const loader = vi.fn().mockResolvedValue({ value: 2 });

    await expect(coordinator.run('store:overview', loader)).resolves.toEqual({ value: 1 });
    redis.values.set('test-cache:version:store:overview', '1');
    redis.values.set('test-cache:v1:store:overview', JSON.stringify({ value: 3 }));

    await expect(coordinator.run('store:overview', loader)).resolves.toEqual({ value: 3 });
    expect(loader).not.toHaveBeenCalled();
  });

  it('fails open when the versioned cache read cannot be resolved', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('redis offline'));
    vi.stubGlobal('fetch', fetchMock);
    const coordinator = new CachedReadCoordinator(new RedisJsonCache('test-cache', 30));
    const loader = vi.fn().mockResolvedValue({ value: 7 });

    await expect(coordinator.run('store:overview', loader)).resolves.toEqual({ value: 7 });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent cache misses before duplicating Redis or source work', async () => {
    const redis = installRedisMock();
    let resolveLoader!: (value: { value: number }) => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const source = new Promise<{ value: number }>((resolve) => {
      resolveLoader = resolve;
    });
    const coordinator = new CachedReadCoordinator(new RedisJsonCache('test-cache', 30));
    const loader = vi.fn(() => {
      markStarted();
      return source;
    });

    const first = coordinator.run('store:overview', loader);
    const second = coordinator.run('store:overview', loader);
    await started;
    resolveLoader({ value: 11 });

    await expect(Promise.all([first, second])).resolves.toEqual([{ value: 11 }, { value: 11 }]);
    expect(loader).toHaveBeenCalledTimes(1);
    expect(redis.commands.map((command) => command[0])).toEqual(['EVAL', 'SET']);
  });

  it('fresh reads advance the generation, recompute once, and populate only the new generation', async () => {
    const redis = installRedisMock({
      'test-cache:v0:store:overview': JSON.stringify({ value: 1 }),
    });
    const coordinator = new CachedReadCoordinator(new RedisJsonCache('test-cache', 30));
    const loader = vi.fn().mockResolvedValue({ value: 123 });

    await expect(
      coordinator.run('store:overview', loader, { fresh: true }),
    ).resolves.toEqual({ value: 123 });

    expect(loader).toHaveBeenCalledTimes(1);
    expect(redis.commands.map((command) => command[0])).toEqual(['INCR', 'SET']);
    expect(redis.values.get('test-cache:version:store:overview')).toBe('1');
    expect(redis.values.get('test-cache:v1:store:overview')).toBe(JSON.stringify({ value: 123 }));
  });

  it('does not let Refresh join an older in-flight computation', async () => {
    const redis = installRedisMock();
    let resolveOld!: (value: { value: number }) => void;
    let markOldStarted!: () => void;
    const oldStarted = new Promise<void>((resolve) => {
      markOldStarted = resolve;
    });
    const oldSource = new Promise<{ value: number }>((resolve) => {
      resolveOld = resolve;
    });
    const coordinator = new CachedReadCoordinator(new RedisJsonCache('test-cache', 30));
    const oldLoader = vi.fn(() => {
      markOldStarted();
      return oldSource;
    });
    const freshLoader = vi.fn().mockResolvedValue({ value: 2 });

    const oldRead = coordinator.run('store:overview', oldLoader);
    await oldStarted;

    await expect(
      coordinator.run('store:overview', freshLoader, { fresh: true }),
    ).resolves.toEqual({ value: 2 });
    expect(freshLoader).toHaveBeenCalledTimes(1);

    resolveOld({ value: 1 });
    await expect(oldRead).resolves.toEqual({ value: 1 });

    const fallback = vi.fn().mockResolvedValue({ value: 99 });
    await expect(coordinator.run('store:overview', fallback)).resolves.toEqual({ value: 2 });
    expect(fallback).not.toHaveBeenCalled();
    expect(redis.values.get('test-cache:v0:store:overview')).toBe(JSON.stringify({ value: 1 }));
    expect(redis.values.get('test-cache:v1:store:overview')).toBe(JSON.stringify({ value: 2 }));
  });

  it('versioned invalidation cannot be undone by an older loader finishing afterward', async () => {
    const redis = installRedisMock();
    let resolveOld!: (value: { value: number }) => void;
    let markOldStarted!: () => void;
    const oldStarted = new Promise<void>((resolve) => {
      markOldStarted = resolve;
    });
    const oldSource = new Promise<{ value: number }>((resolve) => {
      resolveOld = resolve;
    });
    const coordinator = new CachedReadCoordinator(new RedisJsonCache('test-cache', 30));

    const oldRead = coordinator.run('store:overview', () => {
      markOldStarted();
      return oldSource;
    });
    await oldStarted;
    await coordinator.invalidate('store:overview');
    resolveOld({ value: 1 });
    await oldRead;

    const loader = vi.fn().mockResolvedValue({ value: 3 });
    await expect(coordinator.run('store:overview', loader)).resolves.toEqual({ value: 3 });
    expect(loader).toHaveBeenCalledTimes(1);
    expect(redis.values.get('test-cache:v0:store:overview')).toBe(JSON.stringify({ value: 1 }));
    expect(redis.values.get('test-cache:v1:store:overview')).toBe(JSON.stringify({ value: 3 }));
  });

  it('can invalidate all query variants through one store-scoped generation', async () => {
    const redis = installRedisMock();
    const coordinator = new CachedReadCoordinator(new RedisJsonCache('test-cache', 30));
    const firstLoader = vi.fn().mockResolvedValue({ range: '30d' });
    const secondLoader = vi.fn().mockResolvedValue({ range: '7d' });

    await coordinator.run('store:30d', firstLoader, { versionScope: 'store-1' });
    await coordinator.run('store:7d', secondLoader, { versionScope: 'store-1' });
    expect(firstLoader).toHaveBeenCalledTimes(1);
    expect(secondLoader).toHaveBeenCalledTimes(1);

    await coordinator.invalidate('store-1');

    await coordinator.run('store:30d', firstLoader, { versionScope: 'store-1' });
    await coordinator.run('store:7d', secondLoader, { versionScope: 'store-1' });
    expect(firstLoader).toHaveBeenCalledTimes(2);
    expect(secondLoader).toHaveBeenCalledTimes(2);
    expect(redis.values.get('test-cache:version:store-1')).toBe('1');
  });
});
