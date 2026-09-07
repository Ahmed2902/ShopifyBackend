import { describe, expect, it, vi } from 'vitest';
import { InFlightCoalescer } from '../../src/lib/in-flight-coalescer.js';

describe('InFlightCoalescer', () => {
  it('shares one loader promise for concurrent requests with the same key', async () => {
    let release!: (value: number) => void;
    const loader = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          release = resolve;
        }),
    );
    const coalescer = new InFlightCoalescer();

    const first = coalescer.run('store-1:overview', loader);
    const second = coalescer.run('store-1:overview', loader);

    expect(loader).toHaveBeenCalledTimes(1);
    expect(coalescer.size).toBe(1);

    release(42);
    await expect(Promise.all([first, second])).resolves.toEqual([42, 42]);
    expect(coalescer.size).toBe(0);
  });

  it('removes rejected work so a later request can retry', async () => {
    const loader = vi
      .fn<() => Promise<number>>()
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce(7);
    const coalescer = new InFlightCoalescer();

    await expect(coalescer.run('same-key', loader)).rejects.toThrow('temporary failure');
    await expect(coalescer.run('same-key', loader)).resolves.toBe(7);

    expect(loader).toHaveBeenCalledTimes(2);
    expect(coalescer.size).toBe(0);
  });

  it('fails open when the bounded key map is saturated', async () => {
    let release!: () => void;
    const blocker = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coalescer = new InFlightCoalescer(1);
    const first = coalescer.run('first', () => blocker);
    const secondLoader = vi.fn().mockResolvedValue('second');

    await expect(coalescer.run('second', secondLoader)).resolves.toBe('second');
    expect(secondLoader).toHaveBeenCalledTimes(1);
    expect(coalescer.size).toBe(1);

    release();
    await first;
    expect(coalescer.size).toBe(0);
  });
});
