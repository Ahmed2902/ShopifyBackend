import { decryptSecret } from '../../integrations/integration.utils.js';
import type { ConversionDestinationConfig, DeliveryClaim, ProviderDeliveryResult } from '../conversion-delivery.types.js';
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

export async function deliverTikTokPurchase(delivery: DeliveryClaim): Promise<ProviderDeliveryResult> {
  const tokenCiphertext = delivery.destination.accessTokenCiphertext;
  if (!tokenCiphertext) {
    throw new ConversionProviderError(
      'TikTok Events API destination is missing an Events Manager access token',
      false,
      'TIKTOK_EVENTS_TOKEN_MISSING',
    );
  }
  if (!delivery.clickId) {
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
        event: 'CompletePayment',
        event_time: Math.floor(delivery.eventAt.getTime() / 1000),
        event_id: delivery.eventKey,
        user: { ttclid: delivery.clickId },
        ...(delivery.eventSourceUrl ? { page: { url: delivery.eventSourceUrl } } : {}),
        properties: {
          currency: delivery.currencyCode,
          value: Number(delivery.value),
          order_id: delivery.shopifyOrderId,
        },
      },
    ],
  };
  if (config.testEventCode) body.test_event_code = config.testEventCode;

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
    throw new ConversionProviderError('TikTok Events API request failed', true, 'TIKTOK_EVENTS_NETWORK');
  }

  const payload = await responseJson(response);
  if (!response.ok || payload.code !== 0) {
    const code = payload.code !== undefined ? String(payload.code) : String(response.status);
    const message = payload.message ?? `TikTok Events API returned HTTP ${response.status}`;
    const retryable = response.status === 429 || response.status >= 500;
    throw new ConversionProviderError(message, retryable, code);
  }

  return { providerRequestId: payload.request_id ?? null };
}
