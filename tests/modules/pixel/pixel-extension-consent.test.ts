import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

async function pixel(privacy: Record<string, boolean>) {
  const subscriptions = new Map<string, (event: unknown) => void>();
  const timers: Array<() => void> = [];
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  let registered: Promise<void> | undefined;
  let update: (event: unknown) => void = () => undefined;
  const storage = new Map<string, string>();
  const source = readFileSync(new URL('../../../extensions/stride-pixel/src/index.js', import.meta.url), 'utf8').replace(/^import[^\n]+\n/, '');
  runInNewContext(source, {
    URL, Promise, Date, JSON, fetch,
    setTimeout: (callback: () => void) => { timers.push(callback); return timers.length; }, clearTimeout: () => undefined,
    register: (callback: (context: unknown) => Promise<void>) => { registered = callback({
      init: { customerPrivacy: privacy },
      analytics: { subscribe: (name: string, handler: (event: unknown) => void) => subscriptions.set(name, handler) },
      customerPrivacy: { subscribe: (_: string, handler: (event: unknown) => void) => { update = handler; } },
      browser: { sessionStorage: {
        getItem: async (key: string) => storage.get(key) ?? null,
        setItem: async (key: string, value: string) => { storage.set(key, value); },
        removeItem: async (key: string) => { storage.delete(key); },
      } },
      settings: { collectorUrl: 'https://collector.test', installationId: 'test', collectorToken: 'test-token' },
    }); },
  });
  await registered;
  return {
    fetch, update,
    event: async () => {
      subscriptions.get('page_viewed')!({ id: 'test-event', name: 'page_viewed', timestamp: new Date().toISOString(),
        clientId: 'visitor', context: { document: { location: { href: 'https://store.test/?fbclid=click' } } } });
      // Allow the extension's serial handling and storage promises to complete.
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    flush: async () => { for (const timer of timers.splice(0)) timer(); await new Promise<void>((resolve) => setImmediate(resolve)); },
  };
}

describe('Pixel advertising permission from Shopify customer privacy', () => {
  it.each([
    [{ analyticsProcessingAllowed: true, marketingAllowed: false, saleOfDataAllowed: true }, false],
    [{ analyticsProcessingAllowed: true, marketingAllowed: true, saleOfDataAllowed: false }, false],
    [{ analyticsProcessingAllowed: true, marketingAllowed: true, saleOfDataAllowed: true }, true],
  ])('keeps advertising disclosure separate from analytics permission: %j', async (privacy, expected) => {
    const extension = await pixel(privacy); await extension.event(); await extension.flush();
    expect(extension.fetch).toHaveBeenCalledOnce();
    expect(JSON.parse(extension.fetch.mock.calls[0]![1].body).events[0].adSharingAllowed).toBe(expected);
  });

  it('removes sharing permission from queued events on withdrawal', async () => {
    const extension = await pixel({ analyticsProcessingAllowed: true, marketingAllowed: true, saleOfDataAllowed: true });
    await extension.event();
    extension.update({ customerPrivacy: { analyticsProcessingAllowed: true, marketingAllowed: false, saleOfDataAllowed: true } });
    await extension.flush();
    expect(JSON.parse(extension.fetch.mock.calls[0]![1].body).events[0].adSharingAllowed).toBe(false);
  });

  it('drops queued analytics when analytics permission is withdrawn', async () => {
    const extension = await pixel({ analyticsProcessingAllowed: true, marketingAllowed: true, saleOfDataAllowed: true });
    await extension.event(); extension.update({ customerPrivacy: { analyticsProcessingAllowed: false } }); await extension.flush();
    expect(extension.fetch).not.toHaveBeenCalled();
  });
});
