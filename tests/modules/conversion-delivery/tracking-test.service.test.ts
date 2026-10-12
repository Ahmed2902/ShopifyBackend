import { beforeEach, describe, expect, it, vi } from 'vitest';
import { TrackingTestService } from '../../../src/modules/conversion-delivery/tracking-test.service.js';
import type { ConversionDeliveryRepository } from '../../../src/modules/conversion-delivery/conversion-delivery.repository.js';
import type { BillingService } from '../../../src/modules/billing/billing.service.js';
import { prisma } from '../../../src/lib/prisma.js';
vi.mock('../../../src/lib/prisma.js', () => ({ prisma: { store: { findUnique: vi.fn() } } }));
const destination = { id: 'destination-a', storeId: 'store-a', provider: 'META', status: 'ACTIVE', externalId: 'pixel-a', configJson: { authSource: 'META_CONNECTION', adAccountId: 'act_a' }, accessTokenCiphertext: null };
function setup(provider = 'META') {
  const repo = { findDestinationWithSecret: vi.fn().mockResolvedValue({ ...destination, provider }) };
  const billing = { requireAdProviderReadOnly: vi.fn().mockResolvedValue({}) };
  const sender = vi.fn().mockImplementation(async (_claim, beforeSend) => { await beforeSend(); return { providerRequestId: 'receipt' }; });
  const service = new TrackingTestService(repo as unknown as ConversionDeliveryRepository, billing as unknown as BillingService, { META: sender, TIKTOK: sender, GOOGLE_ADS: sender });
  return { service, repo, billing, sender };
}
beforeEach(() => { vi.mocked(prisma.store.findUnique).mockResolvedValue({ myshopifyDomain: 'current.myshopify.com', currencyCode: 'USD' } as never); });
describe('isolated tracking diagnostics', () => {
  it.each(['META', 'TIKTOK'])('sends %s only with transient Test Events routing and synthetic identifiers', async provider => {
    const { service, sender, repo, billing } = setup(provider);
    const result = await service.run('store-a', 'destination-a', 'TEST123');
    const claim = sender.mock.calls[0]![0];
    expect(claim.destination.configJson.testEventCode).toBe('TEST123');
    expect(claim.sourceOrderId).toBeNull();
    expect(claim.sourceEventId).toBeNull();
    expect(claim.shopifyOrderId).toBe('gid://shopify/Order/0');
    expect(claim.clickId).toBeNull();
    expect(claim.eventKey).toMatch(/^metrico-test:/);
    expect(result).toMatchObject({ status: 'TEST_EVENT_ACCEPTED', liveDeliveryVerified: false, providerRequestId: 'receipt' });
    expect(repo.findDestinationWithSecret).toHaveBeenNthCalledWith(1, 'store-a', 'destination-a');
    expect(billing.requireAdProviderReadOnly).toHaveBeenCalledTimes(2);
    expect(destination.configJson).not.toHaveProperty('testEventCode');
  });
  it('Google always uses validation-only and never claims live delivery', async () => {
    const { service, sender } = setup('GOOGLE_ADS');
    const result = await service.run('store-a', 'destination-a');
    expect(sender.mock.calls[0]![2]).toEqual({ validateOnly: true });
    expect(result).toMatchObject({ status: 'VALIDATION_PASSED', liveDeliveryVerified: false });
  });
  it.each(['META', 'TIKTOK'])('blocks %s without a test code', async provider => {
    const { service, sender } = setup(provider);
    await expect(service.run('store-a', 'destination-a')).rejects.toMatchObject({ code: 'TRACKING_TEST_CODE_REQUIRED' });
    expect(sender).not.toHaveBeenCalled();
  });
  it('blocks cross-store/missing destinations without accessing a provider', async () => {
    const { service, repo, sender } = setup();
    repo.findDestinationWithSecret.mockResolvedValue(null as never);
    await expect(service.run('other-store', 'destination-a', 'TEST')).rejects.toMatchObject({ code: 'TRACKING_TEST_DESTINATION_REQUIRED' });
    expect(repo.findDestinationWithSecret).toHaveBeenCalledWith('other-store', 'destination-a');
    expect(sender).not.toHaveBeenCalled();
  });
  it('blocks a plan rejection before accessing a provider', async () => {
    const { service, billing, sender } = setup();
    billing.requireAdProviderReadOnly.mockRejectedValue(new Error('plan denied'));
    await expect(service.run('store-a', 'destination-a', 'TEST')).rejects.toThrow('plan denied');
    expect(sender).not.toHaveBeenCalled();
  });
  it('rechecks destination changes after credential preparation', async () => {
    const { service, repo } = setup();
    repo.findDestinationWithSecret.mockResolvedValueOnce(destination).mockResolvedValueOnce({ ...destination, status: 'DISABLED' });
    await expect(service.run('store-a', 'destination-a', 'TEST')).rejects.toMatchObject({ code: 'TRACKING_TEST_SETTINGS_CHANGED' });
  });
});
