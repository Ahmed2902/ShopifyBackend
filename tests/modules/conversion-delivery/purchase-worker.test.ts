import { beforeEach, describe, expect, it, vi } from 'vitest';
const { send, enrich, dev, google } = vi.hoisted(() => ({ send: vi.fn(), enrich: vi.fn(), dev: vi.fn(), google: vi.fn() }));
vi.mock('../../../src/modules/conversion-delivery/providers/meta-conversion.provider.js', () => ({ deliverMetaPurchase: send }));
vi.mock('../../../src/modules/conversion-delivery/providers/google-conversion.provider.js', () => ({ deliverGooglePurchase: google }));
vi.mock('../../../src/modules/conversion-delivery/signal-enrichment.service.js', () => ({ enrichConversionSignal: enrich }));
vi.mock('../../../src/modules/conversion-delivery/purchase-test.service.js', () => ({ requireDevelopmentStore: dev }));
vi.mock('../../../src/modules/conversion-delivery/conversion-content.js', () => ({ freezeLegacyPurchaseFacts: vi.fn(), prepareConversionContents: vi.fn() }));
import { ConversionDeliveryService } from '../../../src/modules/conversion-delivery/conversion-delivery.service.js';
import { ConversionProviderError } from '../../../src/modules/conversion-delivery/providers/conversion-provider.error.js';
import { encryptSecret } from '../../../src/modules/integrations/integration.utils.js';
const now = new Date();
const base = { id: 'delivery', storeId: 'store', destinationId: 'destination', provider: 'META', sourceOrderId: 'order', sourceEventId: 'source', sourceGenerationAt: now,
  eventName: 'PURCHASE', shopifyOrderId: 'gid://shopify/Order/1', eventAt: now, createdAt: now, attempts: 0,
  clickId: null, destination: { configJson: {} } };
function setup(overrides = {}) {
  const claim = { ...base, ...overrides };
  const repo = { recoverStaleClaims: vi.fn(), claimDue: vi.fn().mockResolvedValue([claim]), hasAdvertisingConsent: vi.fn().mockResolvedValue(true),
    recordCoverage: vi.fn(), markDelivered: vi.fn(), markValidated: vi.fn(), markFailed: vi.fn(), pauseForMatching: vi.fn(), discardForConsent: vi.fn() };
  const billing = { requireAdProviderReadOnly: vi.fn() };
  return { repo, claim, service: new ConversionDeliveryService(repo as never, () => now, billing as never) };
}
beforeEach(() => { vi.clearAllMocks(); dev.mockResolvedValue(undefined); enrich.mockResolvedValue({ clientIp: '8.8.4.4', userAgent: 'Observed browser' });
  send.mockImplementation(async (_claim, beforeSend) => { await beforeSend(); return { providerRequestId: 'meta-receipt' }; });
  google.mockImplementation(async (_claim, beforeSend) => { await beforeSend(); return { providerRequestId: null, validationWarningCount: 0 }; }); });
describe('SDK-independent purchase worker', () => {
  it('sends a purchase using observed network evidence with no Meta SDK cookie or click', async () => {
    const { service, repo } = setup();
    await expect(service.processDue()).resolves.toMatchObject({ delivered: 1 });
    expect(send.mock.calls[0]![0].match).toEqual({ clientIp: '8.8.4.4', userAgent: 'Observed browser' });
    expect(repo.hasAdvertisingConsent).toHaveBeenCalledTimes(2);
    expect(repo.markDelivered).toHaveBeenCalledWith('delivery', 'meta-receipt', now);
  });
  it('waits briefly for enrichment without consuming provider retry attempts', async () => {
    send.mockRejectedValue(new ConversionProviderError('Missing', false, 'META_CAPI_MATCH_ID_MISSING'));
    const { service, repo } = setup();
    await expect(service.processDue()).resolves.toMatchObject({ retrying: 1, dead: 0 });
    expect(repo.pauseForMatching).toHaveBeenCalledWith('delivery', new Date(now.getTime() + 15_000));
    expect(repo.markFailed).not.toHaveBeenCalled();
  });
  it('ends the matching wait honestly at the deadline', async () => {
    send.mockRejectedValue(new ConversionProviderError('Missing', false, 'META_CAPI_MATCH_ID_MISSING'));
    const { service, repo } = setup({ createdAt: new Date(now.getTime() - 61_000) });
    await expect(service.processDue()).resolves.toMatchObject({ dead: 1 });
    expect(repo.pauseForMatching).not.toHaveBeenCalled();
    expect(repo.markFailed.mock.calls[0]![1]).toBe('DEAD');
  });
  it('rechecks withdrawal immediately before provider delivery', async () => {
    const { service, repo } = setup(); repo.hasAdvertisingConsent.mockResolvedValueOnce(true).mockResolvedValue(false);
    await expect(service.processDue()).resolves.toMatchObject({ delivered: 0, dead: 1 });
    expect(repo.discardForConsent).toHaveBeenCalledOnce();
    expect(repo.markDelivered).not.toHaveBeenCalled();
  });
  it('decrypts an explicit checkout test code and verifies development status twice', async () => {
    const { service } = setup({ isTestDelivery: true, testCodeCiphertext: encryptSecret('TEST123'), testExpiresAt: new Date(now.getTime() + 60_000) });
    await service.processDue();
    expect(send.mock.calls[0]![0].testEventCode).toBe('TEST123'); expect(dev).toHaveBeenCalledTimes(2);
  });
  it('cannot upload a Google test purchase and labels validation separately', async () => {
    const { service, repo } = setup({ provider: 'GOOGLE_ADS', isTestDelivery: true, testExpiresAt: new Date(now.getTime() + 60_000) });
    await service.processDue();
    expect(google.mock.calls[0]![2]).toEqual({ validateOnly: true });
    expect(repo.markValidated).toHaveBeenCalledWith('delivery', null, 0); expect(repo.markDelivered).not.toHaveBeenCalled();
  });
  it('cannot send an expired checkout test', async () => {
    const { service } = setup({ isTestDelivery: true, testExpiresAt: new Date(now.getTime() - 1) });
    await service.processDue(); expect(send).not.toHaveBeenCalled(); expect(google).not.toHaveBeenCalled();
  });
});
