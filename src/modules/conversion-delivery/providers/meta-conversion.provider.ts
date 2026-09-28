import { env } from '../../../config/env.js';
import { decryptSecret } from '../../integrations/integration.utils.js';
import type { ConversionDestinationConfig, DeliveryClaim, ProviderDeliveryResult } from '../conversion-delivery.types.js';
import { ConversionProviderError } from './conversion-provider.error.js';

const REQUEST_TIMEOUT_MS = 10_000;

type MetaResponse = {
  events_received?: number;
  fbtrace_id?: string;
  error?: { message?: string; code?: number; error_subcode?: number; is_transient?: boolean };
};

function fbc(clickId: string, clickAt: Date) {
  if (clickId.startsWith('fb.1.')) return clickId;
  return `fb.1.${clickAt.getTime()}.${clickId}`;
}

async function responseJson(response: Response): Promise<MetaResponse> {
  try {
    return (await response.json()) as MetaResponse;
  } catch {
    return {};
  }
}

export async function deliverMetaPurchase(delivery: DeliveryClaim): Promise<ProviderDeliveryResult> {
  const tokenCiphertext = delivery.destination.accessTokenCiphertext;
  if (!tokenCiphertext) {
    throw new ConversionProviderError(
      'Meta Conversions API destination is missing an Events Manager access token',
      false,
      'META_CAPI_TOKEN_MISSING',
    );
  }
  if (!delivery.clickId) {
    throw new ConversionProviderError(
      'Meta Purchase has no consented fbclid/fbc match identifier',
      false,
      'META_CAPI_MATCH_ID_MISSING',
    );
  }

  const config = (delivery.destination.configJson ?? {}) as ConversionDestinationConfig;
  const endpoint = new URL(
    `https://graph.facebook.com/${env.META_API_VERSION}/${encodeURIComponent(delivery.destination.externalId)}/events`,
  );
  endpoint.searchParams.set('access_token', decryptSecret(tokenCiphertext));

  const body: Record<string, unknown> = {
    data: [
      {
        event_name: 'Purchase',
        event_time: Math.floor(delivery.eventAt.getTime() / 1000),
        event_id: delivery.eventKey,
        action_source: 'website',
        ...(delivery.eventSourceUrl ? { event_source_url: delivery.eventSourceUrl } : {}),
        user_data: {
          fbc: fbc(delivery.clickId, delivery.attributionEventAt ?? delivery.eventAt),
        },
        custom_data: {
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
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ConversionProviderError('Meta Conversions API request failed', true, 'META_CAPI_NETWORK');
  }

  const payload = await responseJson(response);
  if (!response.ok || payload.error) {
    const code = payload.error?.code ? String(payload.error.code) : String(response.status);
    const message = payload.error?.message ?? `Meta Conversions API returned HTTP ${response.status}`;
    const retryable = response.status === 429 || response.status >= 500 || payload.error?.is_transient === true;
    throw new ConversionProviderError(message, retryable, code);
  }
  if ((payload.events_received ?? 0) < 1) {
    throw new ConversionProviderError(
      'Meta Conversions API accepted the request but reported zero received events',
      true,
      'META_CAPI_ZERO_RECEIVED',
    );
  }

  return { providerRequestId: payload.fbtrace_id ?? null };
}
