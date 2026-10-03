import { tiktokUserData } from '../matching.js';
import { decryptSecret } from '../../integrations/integration.utils.js';
import type {
  BeforeConversionSend,
  ConversionDestinationConfig,
  DeliveryClaim,
  ProviderDeliveryResult,
} from '../conversion-delivery.types.js';
import { ConversionProviderError } from './conversion-provider.error.js';

const REQUEST_TIMEOUT_MS = 10_000;
const TIKTOK_EVENTS_ENDPOINT = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';

type TikTokResponse = {
  code?: number;
  message?: string;
  request_id?: string;
};

async function responseJson(response: Response): Promise<TikTokResponse> {
  try {
    return (await response.json()) as TikTokResponse;
  } catch {
    return {};
  }
}

export async function deliverTikTokPurchase(
  delivery: DeliveryClaim,
  beforeSend: BeforeConversionSend,
): Promise<ProviderDeliveryResult> {
  if (
    !['PRODUCT_VIEW', 'ADD_TO_CART', 'BEGIN_CHECKOUT', 'PURCHASE'].includes(
      delivery.eventName ?? 'PURCHASE',
    )
  )
    throw new ConversionProviderError(
      'Unsupported TikTok standard event',
      false,
      'TIKTOK_EVENT_UNSUPPORTED',
    );
  const tokenCiphertext = delivery.destination.accessTokenCiphertext;
  if (!tokenCiphertext) {
    throw new ConversionProviderError(
      'TikTok Events API destination is missing an Events Manager access token',
      false,
      'TIKTOK_EVENTS_TOKEN_MISSING',
    );
  }
  const user = tiktokUserData(delivery.match ?? {}, delivery.clickId);
  if (!delivery.clickId && !user.ttp && !user.email && !user.phone && !user.external_id) {
    throw new ConversionProviderError(
      'TikTok Purchase has no consented ttclid match identifier',
      false,
      'TIKTOK_MATCH_ID_MISSING',
    );
  }

  const config = (delivery.destination.configJson ?? {}) as ConversionDestinationConfig;
  const body: Record<string, unknown> = {
    event_source: 'web',
    event_source_id: delivery.destination.externalId,
    data: [
      {
        // TikTok renamed CompletePayment to Purchase for new Web/Events API integrations in 2025.
        event: (
          {
            PRODUCT_VIEW: 'ViewContent',
            ADD_TO_CART: 'AddToCart',
            BEGIN_CHECKOUT: 'InitiateCheckout',
            PURCHASE: 'Purchase',
          } as Record<string, string>
        )[delivery.eventName ?? 'PURCHASE'],
        event_time: Math.floor(delivery.eventAt.getTime() / 1000),
        event_id: delivery.eventKey,
        user,
        ...(delivery.eventSourceUrl ? { page: { url: delivery.eventSourceUrl } } : {}),
        properties: {
          ...(delivery.currencyCode ? { currency: delivery.currencyCode } : {}),
          ...(delivery.value !== null && delivery.value !== undefined
            ? { value: Number(delivery.value) }
            : {}),
          ...(delivery.shopifyOrderId ? { order_id: delivery.shopifyOrderId } : {}),
        },
      },
    ],
  };
  if (config.testEventCode) body.test_event_code = config.testEventCode;

  await beforeSend();
  let response: Response;
  try {
    response = await fetch(TIKTOK_EVENTS_ENDPOINT, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Access-Token': decryptSecret(tokenCiphertext),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ConversionProviderError(
      'TikTok Events API request failed',
      true,
      'TIKTOK_EVENTS_NETWORK',
    );
  }

  const payload = await responseJson(response);
  if (!response.ok || payload.code !== 0) {
    const code = payload.code !== undefined ? String(payload.code) : String(response.status);
    const message = `TikTok rejected conversion delivery (HTTP ${response.status})`;
    const retryable = response.status === 429 || response.status >= 500;
    throw new ConversionProviderError(message, retryable, code);
  }

  return { providerRequestId: payload.request_id ?? null };
}
