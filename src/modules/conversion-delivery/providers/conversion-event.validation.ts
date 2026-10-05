import type { DeliveryClaim } from '../conversion-delivery.types.js';
import { ConversionProviderError } from './conversion-provider.error.js';

export function assertCanonicalPurchase(delivery: DeliveryClaim) {
  if ((delivery.eventName ?? 'PURCHASE') !== 'PURCHASE') return;
  if (delivery.value === null || delivery.value === undefined ||
      !String(delivery.value).trim() || !Number.isFinite(Number(delivery.value)) ||
      !delivery.currencyCode || !/^[A-Z]{3}$/.test(delivery.currencyCode) ||
      !delivery.shopifyOrderId || !/^gid:\/\/shopify\/Order\/\d+$/.test(delivery.shopifyOrderId)) {
    throw new ConversionProviderError('Canonical Purchase money or order is unavailable', false, 'COMMERCE_TRUTH_MISSING');
  }
}
