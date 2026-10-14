import { describe, expect, it, vi } from 'vitest';
import { ConversionDeliveryService } from '../../../src/modules/conversion-delivery/conversion-delivery.service.js';
import { ConversionProviderError } from '../../../src/modules/conversion-delivery/providers/conversion-provider.error.js';
import { env } from '../../../src/config/env.js';
const provider = vi.hoisted(() => ({ send: vi.fn() }));
vi.mock('../../../src/modules/conversion-delivery/providers/meta-conversion.provider.js', () => ({ deliverMetaPurchase: provider.send }));
const now = new Date('2026-10-14T12:00:00Z');
function harness(mode = 'LIVE') {
  const destination = { id: 'destination', provider: 'META', storeId: 'store', configJson: { deliveryMode: mode } };
  const claim = { id: 'delivery', storeId: 'store', provider: 'META', destinationId: 'destination', eventName: 'PURCHASE',
    eventAt: now, createdAt: now, value: '100', currencyCode: 'USD', eventKey: 'same-order-key', attempts: 0,
    destination, sourceOrderId: 'order', sourceEventId: null, shopifyOrderId: 'gid://shopify/Order/100', isTestDelivery: false };
  const repo = { activeDestinations: vi.fn().mockResolvedValue([destination]),
    findPurchaseCandidates: vi.fn().mockResolvedValue([{ storeId: 'store', orderId: 'order', shopifyOrderId: claim.shopifyOrderId,
      eventAt: now, value: '100', currencyCode: 'USD', browserMatchAvailable: true, metaClickId: 'click',
      routing: { eligibleProviders: ['META'] } }]), enqueue: vi.fn().mockResolvedValue({ created: true }),
    recoverStaleClaims: vi.fn(), claimDue: vi.fn().mockResolvedValue([claim]), hasAdvertisingConsent: vi.fn().mockResolvedValue(true),
    markDelivered: vi.fn(), markFailed: vi.fn(), pauseForDispatch: vi.fn(), acquireDispatch: vi.fn(),
    recordProviderOutcome: vi.fn().mockResolvedValue(undefined), expirePending: vi.fn() };
  const billing = { requireAdProviderReadOnly: vi.fn().mockResolvedValue(undefined) };
  const service = new ConversionDeliveryService(repo as never, () => now, billing as never);
  provider.send.mockImplementation(async (_claim, before) => { await before(); return { providerRequestId: 'accepted' }; });
  return { repo, claim, service };
}
describe('logical delivery recovery', () => {
  it('records shadow decisions without a provider call', async () => {
    const h = harness('SHADOW'); const before = provider.send.mock.calls.length;
    await h.service.enqueuePurchases();
    expect(h.repo.enqueue.mock.calls[0]![0]).toMatchObject({ skipReason: 'SHADOW_MODE' });
    expect(provider.send.mock.calls.length).toBe(before);
  });
  it('resends the same facts and ID after acceptance followed by a ledger-update crash', async () => {
    const h = harness(); h.repo.markDelivered.mockRejectedValueOnce(new Error('customer@example.com'));
    await h.service.processDue(); await h.service.processDue();
    const sends = provider.send.mock.calls.filter(call => call[0] === h.claim);
    expect(sends).toHaveLength(2); expect(sends.every(call => call[0].eventKey === 'same-order-key' && call[0].value === '100' && call[0].eventAt === now)).toBe(true);
    expect(h.repo.markFailed.mock.calls[0]![3]).not.toContain('customer@example.com');
  });
  it('does not consume an API attempt when a shared rate reservation refuses the send', async () => {
    const h = harness(); h.repo.acquireDispatch.mockRejectedValue(new ConversionProviderError('limited', true, 'MERCHANT_DISPATCH_LIMIT', 2000));
    await h.service.processDue(); expect(h.repo.pauseForDispatch).toHaveBeenCalledOnce();
    expect(h.repo.markFailed).not.toHaveBeenCalled(); expect(h.repo.markDelivered).not.toHaveBeenCalled();
  });
  it('waits out a small clock lead without changing the purchase timestamp or consuming an attempt', async () => {
    const h = harness(); h.claim.eventAt = new Date(now.getTime() + 2000);
    await h.service.processDue();
    expect(h.repo.pauseForDispatch).toHaveBeenCalledWith('delivery', h.claim.eventAt, 'EVENT_CLOCK_WAIT');
    expect(h.repo.markFailed).not.toHaveBeenCalled(); expect(h.repo.markDelivered).not.toHaveBeenCalled();
    expect(h.claim.eventAt.getTime()).toBe(now.getTime() + 2000);
  });
  it('the deployment kill switch prevents claiming or sending', async () => {
    const h = harness(); const previous = env.CONVERSION_DELIVERY_ENABLED; env.CONVERSION_DELIVERY_ENABLED = false;
    try { expect(await h.service.processDue()).toMatchObject({ claimed: 0 }); expect(h.repo.claimDue).not.toHaveBeenCalled(); }
    finally { env.CONVERSION_DELIVERY_ENABLED = previous; }
  });
});
