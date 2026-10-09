import { afterEach, describe, expect, it, vi } from 'vitest';
import { PollingWorker } from '../../src/lib/polling-worker.js';
afterEach(() => {
  vi.useRealTimers();
});
describe('worker health detects stalled processing', () => {
  it('turns unhealthy when a previously successful task repeatedly fails', async () => {
    vi.useFakeTimers();
    const task = vi.fn().mockResolvedValue(undefined);
    const worker = new PollingWorker(1000, task, 'test queue');
    worker.start();
    await vi.advanceTimersByTimeAsync(1000);
    expect(worker.health().healthy).toBe(true);
    task.mockRejectedValue(new Error('database unavailable'));
    await vi.advanceTimersByTimeAsync(121_000);
    expect(worker.health()).toMatchObject({ healthy: false });
    task.mockResolvedValue(undefined);
    await vi.advanceTimersByTimeAsync(1000);
    expect(worker.health().healthy).toBe(true);
    await worker.stop();
    expect(worker.health().healthy).toBe(false);
  });
  it('detects a task stuck in flight without starting overlapping tasks', async () => {
    vi.useFakeTimers();
    let complete!: () => void;
    const task = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    );
    const worker = new PollingWorker(1000, task, 'test queue');
    worker.start();
    await vi.advanceTimersByTimeAsync(901_000);
    expect(task).toHaveBeenCalledOnce();
    expect(worker.health().healthy).toBe(false);
    complete();
    await Promise.resolve();
    await worker.stop();
  });
});
