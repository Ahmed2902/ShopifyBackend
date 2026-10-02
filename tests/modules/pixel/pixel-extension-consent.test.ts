import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { describe, expect, it, vi } from 'vitest';

async function pixel(privacy: Record<string, boolean>, storage = new Map<string, string>()) {
  const subscriptions = new Map<string, (event: unknown) => void>();
  const timers: Array<() => void> = [];
  const fetch = vi.fn().mockResolvedValue({ ok: true });
  let registered: Promise<void> | undefined;
  let update: (event: unknown) => void = () => undefined;
  const source = readFileSync(
    new URL('../../../extensions/stride-pixel/src/index.js', import.meta.url),
    'utf8',
  ).replace(/^import[^\n]+\n/, '');
  runInNewContext(source, {
    URL,
    Promise,
    Date,
    JSON,
    fetch,
    setTimeout: (callback: () => void) => {
      timers.push(callback);
      return timers.length;
    },
    clearTimeout: () => undefined,
    register: (callback: (context: unknown) => Promise<void>) => {
      registered = callback({
        init: { customerPrivacy: privacy },
        analytics: {
          subscribe: (name: string, handler: (event: unknown) => void) =>
            subscriptions.set(name, handler),
        },
        customerPrivacy: {
          subscribe: (_: string, handler: (event: unknown) => void) => {
            update = handler;
          },
        },
        browser: {
          sessionStorage: {
            getItem: async (key: string) => storage.get(key) ?? null,
            setItem: async (key: string, value: string) => {
              storage.set(key, value);
            },
            removeItem: async (key: string) => {
              storage.delete(key);
            },
          },
        },
        settings: {
          collectorUrl: 'https://collector.test',
          installationId: 'test',
          collectorToken: 'test-token',
        },
      });
    },
  });
  await registered;
  return {
    fetch,
    update,
    storage,
    eventRequests: () =>
      fetch.mock.calls.filter((call) => JSON.parse(call[1].body).events.length > 0),
    withdrawals: () => fetch.mock.calls.filter((call) => JSON.parse(call[1].body).withdrawal),
    event: async () => {
      subscriptions.get('page_viewed')!({
        id: 'test-event',
        name: 'page_viewed',
        timestamp: new Date().toISOString(),
        clientId: 'visitor',
        context: { document: { location: { href: 'https://store.test/?fbclid=click' } } },
      });
      // Allow the extension's serial handling and storage promises to complete.
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
    flush: async () => {
      for (const timer of timers.splice(0)) timer();
      await new Promise<void>((resolve) => setImmediate(resolve));
    },
  };
}

describe('Pixel advertising permission from Shopify customer privacy', () => {
  it.each([
    [{ analyticsProcessingAllowed: true, marketingAllowed: false, saleOfDataAllowed: true }, false],
    [{ analyticsProcessingAllowed: true, marketingAllowed: true, saleOfDataAllowed: false }, false],
    [{ analyticsProcessingAllowed: true, marketingAllowed: true, saleOfDataAllowed: true }, true],
  ])(
    'keeps advertising disclosure separate from analytics permission: %j',
    async (privacy, expected) => {
      const extension = await pixel(privacy);
      await extension.event();
      await extension.flush();
      expect(extension.eventRequests()).toHaveLength(1);
      expect(JSON.parse(extension.eventRequests()[0]![1].body).events[0].adSharingAllowed).toBe(
        expected,
      );
    },
  );

  it('removes sharing permission from queued events on withdrawal', async () => {
    const extension = await pixel({
      analyticsProcessingAllowed: true,
      marketingAllowed: true,
      saleOfDataAllowed: true,
    });
    await extension.event();
    extension.update({
      customerPrivacy: {
        analyticsProcessingAllowed: true,
        marketingAllowed: false,
        saleOfDataAllowed: true,
      },
    });
    await extension.flush();
    expect(JSON.parse(extension.eventRequests()[0]![1].body).events[0].adSharingAllowed).toBe(
      false,
    );
  });

  it('drops queued analytics when analytics permission is withdrawn', async () => {
    const extension = await pixel({
      analyticsProcessingAllowed: true,
      marketingAllowed: true,
      saleOfDataAllowed: true,
    });
    await extension.event();
    extension.update({ customerPrivacy: { analyticsProcessingAllowed: false } });
    await extension.flush();
    expect(extension.eventRequests()).toHaveLength(0);
  });
});

describe('Pixel in-flight consent withdrawal', () => {
  it.each(['network', '500', '429'])(
    'downgrades an in-flight %s retry even after permission is granted again',
    async (failure) => {
      const allowed = {
        analyticsProcessingAllowed: true,
        marketingAllowed: true,
        saleOfDataAllowed: true,
      };
      const extension = await pixel(allowed);
      let finish!: (response: { ok: boolean; status: number }) => void;
      let fail!: (error: Error) => void;
      extension.fetch.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            finish = resolve;
            fail = reject;
          }),
      );
      await extension.event();
      await extension.flush();
      expect(extension.eventRequests()).toHaveLength(1);
      expect(JSON.parse(extension.eventRequests()[0]![1].body).events[0].adSharingAllowed).toBe(
        true,
      );
      extension.update({ customerPrivacy: { ...allowed, marketingAllowed: false } });
      extension.update({ customerPrivacy: allowed });
      if (failure === 'network') fail(new Error('connection lost'));
      else finish({ ok: false, status: Number(failure) });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await extension.flush();
      expect(extension.eventRequests()).toHaveLength(2);
      expect(JSON.parse(extension.eventRequests()[1]![1].body).events[0].adSharingAllowed).toBe(
        false,
      );
    },
  );

  it.each([false, true])(
    'drops in-flight analytics permanently for the batch on withdrawal (regrant=%s)',
    async (regrant) => {
      const allowed = {
        analyticsProcessingAllowed: true,
        marketingAllowed: true,
        saleOfDataAllowed: true,
      };
      const extension = await pixel(allowed);
      let finish!: (response: { ok: boolean; status: number }) => void;
      extension.fetch.mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      await extension.event();
      await extension.flush();
      extension.update({ customerPrivacy: { ...allowed, analyticsProcessingAllowed: false } });
      if (regrant) extension.update({ customerPrivacy: allowed });
      finish({ ok: false, status: 500 });
      await new Promise<void>((resolve) => setImmediate(resolve));
      await extension.flush();
      expect(extension.eventRequests()).toHaveLength(1);
    },
  );
});

describe('Durable privacy-only withdrawal', () => {
  it.each(['analyticsProcessingAllowed', 'marketingAllowed', 'saleOfDataAllowed'])(
    'sends %s withdrawal after the source batch succeeded without a later event',
    async (permission) => {
      const allowed = {
        analyticsProcessingAllowed: true,
        marketingAllowed: true,
        saleOfDataAllowed: true,
      };
      const extension = await pixel(allowed);
      await extension.event();
      await extension.flush();
      extension.update({ customerPrivacy: { ...allowed, [permission]: false } });
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(extension.eventRequests()).toHaveLength(1);
      expect(extension.withdrawals()).toHaveLength(1);
      const request = extension.withdrawals()[0]!;
      expect(request[1].keepalive).toBe(true);
      expect(JSON.parse(request[1].body)).toMatchObject({
        events: [],
        withdrawal: { anonymousVisitorId: 'visitor', sessionId: 'test-event' },
      });
      expect(request[1].body).not.toContain('metaClickId');
      expect(request[1].body).not.toContain('pageUrl');
    },
  );

  it('remembers the privacy subject across a page reload without needing a new behavior event', async () => {
    const allowed = {
      analyticsProcessingAllowed: true,
      marketingAllowed: true,
      saleOfDataAllowed: true,
    };
    const first = await pixel(allowed);
    await first.event();
    await first.flush();
    const reopened = await pixel(allowed, first.storage);
    reopened.update({ customerPrivacy: { ...allowed, marketingAllowed: false } });
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(reopened.eventRequests()).toHaveLength(0);
    expect(JSON.parse(reopened.withdrawals()[0]![1].body).withdrawal).toEqual({
      anonymousVisitorId: 'visitor',
      sessionId: 'test-event',
    });
  });
});
