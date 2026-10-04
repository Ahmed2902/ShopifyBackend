import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  authorizeBrowserSignals,
  browserSignalsSchema,
  permittedBrowserPairs,
} from '../../../src/modules/conversion-delivery/browser-signals.js';
import { storefrontEventKey } from '../../../src/modules/conversion-delivery/funnel.repository.js';
const mocks = vi.hoisted(() => ({
  installation: vi.fn(),
  events: vi.fn(),
  destinations: vi.fn(),
  connection: vi.fn(),
  consent: vi.fn(),
  updateContext: vi.fn(),
  create: vi.fn(),
  deliveries: vi.fn(),
  update: vi.fn(),
  billing: vi.fn(),
  contents: vi.fn(),
}));
vi.mock('../../../src/lib/prisma.js', () => ({
  prisma: {
    pixelInstallation: { findUnique: mocks.installation },
    storefrontEvent: { findMany: mocks.events },
    conversionDestination: { findMany: mocks.destinations },
    shopifyConnection: { findUnique: mocks.connection },
    $queryRaw: mocks.consent,
    $executeRaw: mocks.updateContext,
    conversionDelivery: {
      createMany: mocks.create,
      findMany: mocks.deliveries,
      updateMany: mocks.update,
    },
  },
}));
vi.mock('../../../src/modules/billing/billing.service.js', () => ({
  billingService: { requireAdProviderReadOnly: mocks.billing },
}));
vi.mock('../../../src/modules/conversion-delivery/conversion-content.js', () => ({
  prepareConversionContents: mocks.contents,
  metaCustomData: () => ({}),
}));
const generation = new Date('2026-10-04T00:00:00Z');
const storeId = '00000000-0000-4000-8000-000000000001';
const sourceId = '00000000-0000-4000-8000-000000000002';
const destinationId = '00000000-0000-4000-8000-000000000003';
const token = 'a'.repeat(48);
const input = {
  installationId: '00000000-0000-4000-8000-000000000004',
  collectorToken: token,
  eventIds: ['event_client_1'],
};
beforeEach(() => {
  vi.clearAllMocks();
  mocks.installation.mockResolvedValue({
    storeId,
    status: 'ACTIVE',
    collectorTokenHash: createHash('sha256').update(token).digest('hex'),
  });
  mocks.events.mockResolvedValue([
    {
      id: sourceId,
      storeId,
      eventId: input.eventIds[0],
      eventName: 'PAGE_VIEW',
      eventAt: new Date(),
      retentionExpiresAt: new Date(Date.now() + 86400_000),
    },
  ]);
  mocks.destinations.mockResolvedValue([
    {
      id: destinationId,
      externalId: '123456',
      configJson: { browserEvents: true, funnelEvents: true, overlapPolicy: 'STRIDE_EXCLUSIVE' },
    },
  ]);
  mocks.connection.mockResolvedValue({ installedAt: generation });
  mocks.consent.mockResolvedValue([{ sourceEventId: sourceId, destinationId }]);
  mocks.billing.mockResolvedValue(undefined);
  mocks.contents.mockResolvedValue(undefined);
  mocks.deliveries.mockResolvedValue([
    {
      id: 'delivery-id',
      destinationId,
      eventKey: storefrontEventKey(storeId, input.eventIds[0]!),
      sourceEventId: sourceId,
      eventName: 'PAGE_VIEW',
    },
  ]);
});
describe('controlled Meta browser authorization', () => {
  it('uses exactly the server event key, public pixel ID and bounded receipt without secrets', async () => {
    const response = await authorizeBrowserSignals(input);
    expect(response.dispatches).toEqual([
      {
        destinationId,
        clientEventId: 'event_client_1',
        pixelId: '123456',
        eventName: 'PageView',
        eventId: storefrontEventKey(storeId, 'event_client_1'),
        customData: {},
      },
    ]);
    expect(JSON.stringify(response)).not.toContain(token);
    expect(mocks.events.mock.calls[0]![0].where.storeId).toBe(storeId);
    expect(mocks.create.mock.calls[0]![0].skipDuplicates).toBe(true);
    expect(mocks.consent).toHaveBeenCalledTimes(2);
  });
  it.each(['DISABLED', 'ERROR', 'PROVISIONING'])(
    'rejects %s and old collector credentials',
    async (status) => {
      mocks.installation.mockResolvedValue({
        storeId,
        status,
        collectorTokenHash: createHash('sha256').update(token).digest('hex'),
      });
      await expect(authorizeBrowserSignals(input)).rejects.toHaveProperty(
        'code',
        'PIXEL_UNAUTHORIZED',
      );
      expect(mocks.events).not.toHaveBeenCalled();
    },
  );
  it('rejects an invalid credential without echoing it', async () => {
    await expect(
      authorizeBrowserSignals({ ...input, collectorToken: 'b'.repeat(48) }),
    ).rejects.toThrow('Pixel collector credentials are invalid');
    expect(mocks.events).not.toHaveBeenCalled();
  });
  it.each(['UNCONFIRMED', 'OTHER_TRACKER'])(
    'does not initialize paired sharing under %s policy',
    async (overlapPolicy) => {
      mocks.destinations.mockResolvedValue([
        {
          id: destinationId,
          externalId: '123456',
          configJson: { browserEvents: true, funnelEvents: true, overlapPolicy },
        },
      ]);
      expect((await authorizeBrowserSignals(input)).dispatches).toEqual([]);
      expect(mocks.create).not.toHaveBeenCalled();
    },
  );
  it('does not authorize a revoked event or an event from another installation generation', async () => {
    mocks.consent.mockResolvedValue([]);
    expect((await authorizeBrowserSignals(input)).dispatches).toEqual([]);
    expect(mocks.create).not.toHaveBeenCalled();
    const sql = mocks.consent.mock.calls[0]![0];
    expect(sql.values).toContain(storeId);
    expect(sql.values).toContain(generation);
    expect(sql.strings.join('')).toContain('StorefrontConsentWithdrawal');
  });
  it('rechecks withdrawal and destination settings after asynchronous content preparation', async () => {
    mocks.contents.mockImplementation(async () => {
      mocks.consent.mockResolvedValue([]);
    });
    expect((await authorizeBrowserSignals(input)).dispatches).toEqual([]);
    expect(mocks.consent).toHaveBeenCalledTimes(2);
  });
  it('rechecks billing after preparation and suppresses delivery on entitlement revocation', async () => {
    mocks.contents.mockImplementation(async () => {
      mocks.billing.mockRejectedValue(new Error('revoked'));
    });
    expect((await authorizeBrowserSignals(input)).dispatches).toEqual([]);
  });
  it('stores only a validated actual fbp with bounded retention and rejects cookies issued before withdrawal', async () => {
    const fbp = `fb.1.${Date.now() - 1000}.123`;
    await authorizeBrowserSignals({ ...input, fbp });
    const sql = mocks.updateContext.mock.calls[0]![0];
    expect(sql.values).toContain(storeId);
    expect(sql.strings.join('')).toContain('w."revokedBefore" >=');
    expect(sql.strings.join('')).toContain('e."adSharingAllowed"');
    expect(
      sql.values
        .filter((v: unknown) => v instanceof Date)
        .every((d: Date) => d.getTime() <= Date.now() + 48 * 3600_000),
    ).toBe(true);
  });
  it('reports SDK invocation separately and does not redispatch an already reported event', async () => {
    expect(
      (await authorizeBrowserSignals({ ...input, dispatchedDestinationIds: [destinationId] }))
        .dispatches,
    ).toEqual([]);
    expect(mocks.update).toHaveBeenCalledOnce();
    mocks.deliveries.mockResolvedValue([
      {
        id: 'delivery-id',
        destinationId,
        eventKey: storefrontEventKey(storeId, input.eventIds[0]!),
        sourceEventId: sourceId,
        eventName: 'PAGE_VIEW',
        browserDispatchedAt: new Date(),
      },
    ]);
    expect((await authorizeBrowserSignals(input)).dispatches).toEqual([]);
  });
  it('rejects unreviewed customer data and oversized batches at the public boundary', () => {
    expect(browserSignalsSchema.safeParse({ ...input, email: 'private@example.com' }).success).toBe(
      false,
    );
    expect(
      browserSignalsSchema.safeParse({ ...input, eventIds: Array(21).fill('event_client_1') })
        .success,
    ).toBe(false);
    expect(browserSignalsSchema.safeParse({ ...input, fbp: 'fabricated' }).success).toBe(false);
  });
  it('performs no database query for an empty scope', async () => {
    await permittedBrowserPairs(storeId, generation, [], [destinationId]);
    expect(mocks.consent).not.toHaveBeenCalled();
  });
});
