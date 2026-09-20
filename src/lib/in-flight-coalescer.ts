export class InFlightCoalescer {
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(private readonly maxEntries = 250) {}

  run<T>(key: string, loader: () => Promise<T>, options: { onJoin?: () => void } = {}): Promise<T> {
    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) {
      options.onJoin?.();
      return existing;
    }

    // Coalescing is an optimization. Once the bounded map is saturated, run the
    // request normally rather than retaining unbounded tenant/query keys.
    if (this.inFlight.size >= this.maxEntries) return loader();

    const promise = loader().finally(() => {
      if (this.inFlight.get(key) === promise) this.inFlight.delete(key);
    });
    this.inFlight.set(key, promise);
    return promise;
  }

  get size() {
    return this.inFlight.size;
  }
}
