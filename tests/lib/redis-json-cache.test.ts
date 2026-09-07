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

describe('RedisJsonCache / CachedReadCoordinator', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('returns a cached value without executing the source loader', async () => {
    const fetchMock = vi.fn().mockImplementation(() =>
      redisResponse(JSON.stringify({ value: 42 })),
    );
    vi.stubGlobal('fetch', fetchMock);
    const coordinator = new CachedReadCoordinator(new RedisJsonCache('test-cache', 30));
    const loader = vi.fn().mockResolvedValue({ value: 99 });

    await expect(coordinator.run('store:overview', loader)).resolves.toEqual({ value: 42 });

    expect(loader).not.toHaveBeenCalled();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body))).toEqual([
      'GET',
      'test-cache:store:overview',
    ]);
  });

  it('fails open when Redis is unavailable without retrying the same cache miss', async () => {
    const fetchMock = vi.fn().mockRejectedValue(new Error('redis offline'));
    vi.stubGlobal('fetch', fetchMock);
    const coordinator = new CachedReadCoordinator(new RedisJsonCache('test-cache', 30));
    const loader = vi.fn().mockResolvedValue({ value: 7 });

    await expect(coordinator.run('store:overview', loader)).resolves.toEqual({ value: 7 });

    expect(loader).toHaveBeenCalledTimes(1);
    // One GET miss/failure + one best-effort SET. The source result still succeeds.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent cache misses into one source computation', async () => {
    let resolveLoader!: (value: { value: number }) => void;
    const source = new Promise<{ value: number }>((resolve) => {
      resolveLoader = resolve;
    });
    const fetchMock = vi.fn().mockImplementation((_, init?: RequestInit) => {
      const command = JSON.parse(String(init?.body)) as string[];
      if (command[0] === 'GET') return redisResponse(null);
      return redisResponse('OK');
    });
    vi.stubGlobal('fetch', fetchMock);
    const coordinator = new CachedReadCoordinator(new RedisJsonCache('test-cache', 30));
    const loader = vi.fn(() => source);

    const first = coordinator.run('store:overview', loader);
    const second = coordinator.run('store:overview', loader);
    resolveLoader({ value: 11 });

    await expect(Promise.all([first, second])).resolves.toEqual([{ value: 11 }, { value: 11 }]);
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('fresh reads bypass Redis GET, recompute once, and refresh the cached value', async () => {
    const commands: string[][] = [];
    const fetchMock = vi.fn().mockImplementation((_, init?: RequestInit) => {
      const command = JSON.parse(String(init?.body)) as string[];
      commands.push(command);
      return redisResponse(command[0] === 'SET' ? 'OK' : null);
    });
    vi.stubGlobal('fetch', fetchMock);
    const coordinator = new CachedReadCoordinator(new RedisJsonCache('test-cache', 30));
    const loader = vi.fn().mockResolvedValue({ value: 123 });

    await expect(
      coordinator.run('store:overview', loader, { fresh: true }),
    ).resolves.toEqual({ value: 123 });

    expect(loader).toHaveBeenCalledTimes(1);
    expect(commands.map((command) => command[0])).toEqual(['SET']);
    expect(commands[0]).toEqual([
      'SET',
      'test-cache:store:overview',
      JSON.stringify({ value: 123 }),
      'EX',
      '30',
    ]);
  });
});
