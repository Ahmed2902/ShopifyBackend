import { afterEach, describe, expect, it, vi } from 'vitest';
import { PollingWorker } from '../../src/lib/polling-worker.js';

afterEach(() => {
  vi.useRealTimers();
});

describe('PollingWorker', () => {
  it('never overlaps ticks even when the polling interval elapses repeatedly', async () => {
    vi.useFakeTimers();
    let releaseFirst!: () => void;
    const firstTick = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let calls = 0;
    const task = vi.fn(async () => {
      calls += 1;
      if (calls === 1) await firstTick;
    });
    const worker = new PollingWorker(1_000, task, 'test worker failed');

    worker.start();
    await vi.advanceTimersByTimeAsync(5_000);

    expect(task).toHaveBeenCalledTimes(1);

    releaseFirst();
    await Promise.resolve();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(task).toHaveBeenCalledTimes(2);
    await worker.stop();
  });

  it('stops future ticks and waits for an in-flight task to finish', async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const inFlight = new Promise<void>((resolve) => {
      release = resolve;
    });
    const task = vi.fn(async () => {
      await inFlight;
    });
    const worker = new PollingWorker(1_000, task, 'test worker failed');

    worker.start();
    const stopping = worker.stop();
    let stopped = false;
    void stopping.then(() => {
      stopped = true;
    });

    await vi.advanceTimersByTimeAsync(100);
    expect(stopped).toBe(false);

    release();
    await vi.advanceTimersByTimeAsync(25);
    await stopping;
    expect(stopped).toBe(true);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(task).toHaveBeenCalledTimes(1);
  });
});
