import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
const source = readFileSync(
  new URL('../../../extensions/stride-browser-signals/assets/browser-signals.js', import.meta.url),
  'utf8',
);
function embed(
  options: { granted?: boolean; href?: string; referrer?: string; existingSdk?: boolean } = {},
) {
  const stored = new Map<string, string>();
  const timers: Array<{ callback: () => void; delay: number }> = [];
  const listeners = new Map<string, () => void>();
  const scripts: Array<{ onload: () => void; onerror: () => void }> = [];
  const calls = vi.fn();
  const privacy = { granted: options.granted ?? true };
  const dispatch = {
    destinationId: '00000000-0000-4000-8000-000000000001',
    clientEventId: 'shopify_event_1',
    pixelId: '123456',
    eventId: 'stride:event:' + 'a'.repeat(64),
    eventName: 'ViewContent',
    customData: {
      content_ids: ['catalog-sku'],
      content_type: 'product',
      contents: [{ id: 'catalog-sku', quantity: 1 }],
    },
  };
  const batch = {
    expiresAt: Date.now() + 60_000,
    installationId: '00000000-0000-4000-8000-000000000002',
    collectorToken: 'a'.repeat(48),
    collectorUrl: 'https://api.stride.test/v1/pixel/events',
    eventIds: [dispatch.clientEventId],
  };
  stored.set('stride_browser_batch_v1_1', JSON.stringify(batch));
  const fetch = vi.fn(async (_url: unknown, init: { body: string }) => {
    const input = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({
        dispatches: input.dispatchedDestinationIds || input.browserFailureCode ? [] : [dispatch],
        expiresAt: new Date(Date.now() + 5000).toISOString(),
      }),
    };
  });
  const window = {
    location: new URL(options.href ?? 'https://shop.test/products/hero'),
    Shopify: {
      loadFeatures: (_features: unknown, callback: (error?: unknown) => void) => callback(),
      customerPrivacy: {
        analyticsProcessingAllowed: () => privacy.granted,
        marketingAllowed: () => privacy.granted,
        saleOfDataAllowed: () => privacy.granted,
      },
    },
    addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
    ...(options.existingSdk ? { fbq: calls } : {}),
  } as any;
  let cookie = '';
  const document = {
    referrer: options.referrer ?? '',
    head: { appendChild: (script: any) => scripts.push(script) },
    createElement: () => ({}),
    addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
    get cookie() {
      return cookie;
    },
    set cookie(value) {
      if (value.includes('Max-Age=0')) cookie = '';
      else cookie = value;
    },
  };
  runInNewContext(source, {
    window,
    document,
    fetch,
    URL,
    AbortSignal,
    setTimeout: (callback: () => void, delay: number) => {
      timers.push({ callback, delay });
    },
    sessionStorage: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => stored.set(key, value),
      removeItem: (key: string) => stored.delete(key),
      get length() {
        return stored.size;
      },
      key: (i: number) => [...stored.keys()][i] ?? null,
    },
  });
  const sdkReady = (index = 0) => {
    window.fbq.callMethod = (...args: unknown[]) => {
      calls(...args);
      if (args[0] === 'init') cookie = ` _fbp=fb.1.${Date.now()}.12345`;
    };
    scripts[index]!.onload();
  };
  return {
    stored,
    timers,
    scripts,
    calls,
    privacy,
    fetch,
    dispatch,
    batch,
    listeners,
    sdkReady,
    window,
  };
}
describe('consent-aware theme app embed', () => {
  it('does not dispatch into a tracker that replaces the owned SDK during authorization', async () => {
    const e = embed();
    await vi.waitFor(() => expect(e.scripts).toHaveLength(1));
    const foreign = vi.fn();
    e.fetch.mockImplementationOnce(async () => {
      e.window.fbq = foreign;
      return { ok: true, json: async () => ({ dispatches: [e.dispatch], expiresAt: new Date(Date.now() + 5000).toISOString() }) };
    });
    e.sdkReady();
    await vi.waitFor(() => expect(e.fetch).toHaveBeenCalledTimes(3));
    expect(foreign).not.toHaveBeenCalled();
    expect(e.calls.mock.calls.some(c => c[0] === 'trackSingle')).toBe(false);
  });

  it('retries a failed owned SDK without taking over a third-party global', async () => {
    const e = embed();
    await vi.waitFor(() => expect(e.scripts).toHaveLength(1));
    e.scripts[0]!.onerror();
    await vi.waitFor(() => expect(e.fetch).toHaveBeenCalledTimes(2));
    expect(e.window.fbq).toBeUndefined();
    e.stored.set('stride_browser_batch_v1_retry', JSON.stringify(e.batch));
    e.timers.find(t => t.delay === 500)!.callback();
    await vi.waitFor(() => expect(e.scripts).toHaveLength(2));
    e.sdkReady(1);
    await vi.waitFor(() => expect(e.calls.mock.calls.some(c => c[0] === 'trackSingle')).toBe(true));
  });
  it('uses a timed-out SDK after it recovers without injecting a second script', async () => {
    const e = embed();
    await vi.waitFor(() => expect(e.scripts).toHaveLength(1));
    e.timers.find(t => t.delay === 5000)!.callback();
    await vi.waitFor(() => expect(e.fetch).toHaveBeenCalledTimes(2));
    e.sdkReady();
    e.stored.set('stride_browser_batch_v1_retry', JSON.stringify(e.batch));
    e.timers.find(t => t.delay === 500)!.callback();
    await vi.waitFor(() => expect(e.calls.mock.calls.some(c => c[0] === 'trackSingle')).toBe(true));
    expect(e.scripts).toHaveLength(1);
  });
  it('refuses another tracker introduced after its owned SDK fails', async () => {
    const e = embed();
    await vi.waitFor(() => expect(e.scripts).toHaveLength(1));
    e.scripts[0]!.onerror();
    await vi.waitFor(() => expect(e.fetch).toHaveBeenCalledTimes(2));
    const foreign = vi.fn();e.window.fbq = foreign;
    e.stored.set('stride_browser_batch_v1_retry', JSON.stringify(e.batch));
    e.timers.find(t => t.delay === 500)!.callback();
    await vi.waitFor(() => expect(e.fetch).toHaveBeenCalledTimes(4));
    expect(e.window.fbq).toBe(foreign);expect(foreign).not.toHaveBeenCalled();
    expect(e.scripts).toHaveLength(1);
  });

  it('blocks SDK loading if a private URL appears during the first authorization', async () => {
    const e = embed();
    e.window.location.href = 'https://shop.test/products/hero?email=private@example.com';
    await vi.waitFor(() => expect(e.fetch).toHaveBeenCalledTimes(2));
    expect(e.scripts).toHaveLength(0);
    expect(e.calls).not.toHaveBeenCalled();
    expect(JSON.parse(e.fetch.mock.calls[1]![1].body).browserFailureCode).toBe(
      'BROWSER_CONTEXT_BLOCKED',
    );
    expect(JSON.stringify(e.fetch.mock.calls)).not.toContain('private@example.com');
  });
  it('blocks initialization if the storefront navigates to checkout during SDK loading', async () => {
    const e = embed();
    await vi.waitFor(() => expect(e.scripts).toHaveLength(1));
    e.window.location.href = 'https://shop.test/checkout/private-token';
    e.sdkReady();
    await vi.waitFor(() => expect(e.fetch).toHaveBeenCalledTimes(2));
    expect(e.calls.mock.calls.some((c) => c[0] === 'init' || c[0] === 'trackSingle')).toBe(false);
    expect(JSON.parse(e.fetch.mock.calls[1]![1].body).browserFailureCode).toBe(
      'BROWSER_CONTEXT_BLOCKED',
    );
  });
  it('blocks dispatch if private context appears during the final authorization', async () => {
    const e = embed();
    await vi.waitFor(() => expect(e.scripts).toHaveLength(1));
    e.fetch.mockImplementationOnce(async () => {
      e.window.location.href = 'https://shop.test/products/hero#private-token';
      return {
        ok: true,
        json: async () => ({
          dispatches: [e.dispatch],
          expiresAt: new Date(Date.now() + 5000).toISOString(),
        }),
      };
    });
    e.sdkReady();
    await vi.waitFor(() => expect(e.fetch).toHaveBeenCalledTimes(3));
    expect(e.calls.mock.calls.some((c) => c[0] === 'init' || c[0] === 'trackSingle')).toBe(false);
    expect(JSON.parse(e.fetch.mock.calls[2]![1].body).browserFailureCode).toBe(
      'BROWSER_CONTEXT_BLOCKED',
    );
  });
  it('authorizes again after SDK loading and uses the server event ID with trackSingle', async () => {
    const e = embed();
    await vi.waitFor(() => expect(e.scripts).toHaveLength(1));
    expect(e.calls).not.toHaveBeenCalled();
    e.sdkReady();
    await vi.waitFor(() =>
      expect(e.calls.mock.calls.some((c) => c[0] === 'trackSingle')).toBe(true),
    );
    expect(e.calls).toHaveBeenCalledWith(
      'trackSingle',
      '123456',
      'ViewContent',
      e.dispatch.customData,
      { eventID: e.dispatch.eventId },
    );
    await vi.waitFor(() => expect(e.fetch).toHaveBeenCalledTimes(3));
    const report = JSON.parse(e.fetch.mock.calls[2]![1].body);
    expect(report.dispatchedDestinationIds).toEqual([e.dispatch.destinationId]);
    expect(report.fbp).toMatch(/^fb\.1\.\d{13}\.12345$/);
    expect(e.calls).toHaveBeenCalledWith('set', 'autoConfig', false, '123456');
    expect(e.calls.mock.calls.find((c) => c[0] === 'init')).toEqual(['init', '123456']);
  });
  it('blocks SDK initialization when permission is withdrawn during loading and never replays after regrant', async () => {
    const e = embed();
    await vi.waitFor(() => expect(e.scripts).toHaveLength(1));
    e.privacy.granted = false;
    e.listeners.get('visitorConsentCollected')!();
    e.sdkReady();
    await vi.waitFor(() => expect(e.timers.some((t) => t.delay === 500)).toBe(true));
    expect(e.calls.mock.calls.some((c) => c[0] === 'init' || c[0] === 'trackSingle')).toBe(false);
    e.privacy.granted = true;
    e.listeners.get('visitorConsentCollected')!();
    e.stored.set('stride_browser_batch_v1_new', JSON.stringify(e.batch));
    e.timers.find((t) => t.delay === 500)!.callback();
    await Promise.resolve();
    expect(e.calls.mock.calls.some((c) => c[0] === 'trackSingle')).toBe(false);
  });
  it('does not collect a browser identifier or contact Meta before initial consent', async () => {
    const e = embed({ granted: false });
    await Promise.resolve();
    expect(e.fetch).not.toHaveBeenCalled();
    expect(e.scripts).toHaveLength(0);
    expect(e.stored.size).toBe(0);
  });
  it.each([
    { href: 'https://shop.test/checkout/token' },
    { href: 'https://shop.test/cart/c/secret' },
    { href: 'https://shop.test/products/hero?email=private@example.com' },
    { href: 'https://shop.test/products/hero?utm_content=private%40example.com' },
    { href: 'https://shop.test/products/hero#secret' },
    { referrer: 'https://example.com/?token=secret' },
  ])('reports private context without loading or calling the Meta SDK: %j', async (options) => {
    const e = embed(options);
    await vi.waitFor(() => expect(e.fetch).toHaveBeenCalledOnce());
    expect(JSON.parse(e.fetch.mock.calls[0]![1].body).browserFailureCode).toBe(
      'BROWSER_CONTEXT_BLOCKED',
    );
    expect(e.scripts).toHaveLength(0);
    expect(e.calls).not.toHaveBeenCalled();
    expect(JSON.stringify(e.fetch.mock.calls)).not.toContain('private@example.com');
  });
  it('fails closed on an existing SDK without changing its consent or initialization', async () => {
    const e = embed({ existingSdk: true });
    await vi.waitFor(() => expect(e.fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(e.fetch.mock.calls[1]![1].body).browserFailureCode).toBe(
      'EXISTING_META_BROWSER_TRACKER',
    );
    expect(e.calls).not.toHaveBeenCalled();
    expect(e.scripts).toHaveLength(0);
  });
  it('reports an SDK load failure while preserving the independent server path', async () => {
    const e = embed();
    await vi.waitFor(() => expect(e.scripts).toHaveLength(1));
    e.scripts[0]!.onerror();
    await vi.waitFor(() => expect(e.fetch).toHaveBeenCalledTimes(2));
    expect(JSON.parse(e.fetch.mock.calls[1]![1].body).browserFailureCode).toBe(
      'META_SDK_UNAVAILABLE',
    );
    expect(e.calls.mock.calls.some((c) => c[0] === 'trackSingle')).toBe(false);
  });
  it('does not dispatch a retried batch twice, but retains separate action IDs', async () => {
    const e = embed();
    await vi.waitFor(() => expect(e.scripts).toHaveLength(1));
    e.sdkReady();
    await vi.waitFor(() => expect(e.fetch).toHaveBeenCalledTimes(3));
    e.stored.set('stride_browser_batch_v1_retry', JSON.stringify(e.batch));
    e.timers.find((t) => t.delay === 500)!.callback();
    await vi.waitFor(() => expect(e.fetch).toHaveBeenCalledTimes(5));
    expect(e.calls.mock.calls.filter((c) => c[0] === 'trackSingle')).toHaveLength(1);
    e.dispatch.eventId = 'stride:event:' + 'b'.repeat(64);
    e.stored.set('stride_browser_batch_v1_next', JSON.stringify(e.batch));
    e.timers
      .filter((t) => t.delay === 500)
      .at(-1)!
      .callback();
    await vi.waitFor(() =>
      expect(e.calls.mock.calls.filter((c) => c[0] === 'trackSingle')).toHaveLength(2),
    );
  });
});
