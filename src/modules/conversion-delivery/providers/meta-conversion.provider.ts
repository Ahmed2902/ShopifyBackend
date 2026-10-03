import { metaUserData } from '../matching.js';
import { env } from '../../../config/env.js';
import { prisma } from '../../../lib/prisma.js';
import { decryptSecret } from '../../integrations/integration.utils.js';
import type {
  BeforeConversionSend,
  ConversionDestinationConfig,
  DeliveryClaim,
  ProviderDeliveryResult,
} from '../conversion-delivery.types.js';
import { ConversionProviderError } from './conversion-provider.error.js';

const REQUEST_TIMEOUT_MS = 10_000;

type MetaResponse = {
  events_received?: number;
  fbtrace_id?: string;
  error?: { message?: string; code?: number; error_subcode?: number; is_transient?: boolean };
};

async function responseJson(response: Response): Promise<MetaResponse> {
  try {
    return (await response.json()) as MetaResponse;
  } catch {
    return {};
  }
}

async function resolveMetaAccessToken(delivery: DeliveryClaim): Promise<string> {
  const tokenCiphertext = delivery.destination.accessTokenCiphertext;
  const config = (delivery.destination.configJson ?? {}) as ConversionDestinationConfig;
  if (config.authSource !== 'META_CONNECTION') {
    if (tokenCiphertext) return decryptSecret(tokenCiphertext);
    throw new ConversionProviderError(
      'Meta purchase sharing is not connected to a usable Meta account',
      false,
      'META_CAPI_TOKEN_MISSING',
    );
  }

  const connection = await prisma.metaConnection.findUnique({
    where: { storeId: delivery.storeId },
    select: {
      status: true,
      scopes: true,
      accessTokenCiphertext: true,
      tokenExpiresAt: true,
      selectedAdAccountIds: true,
    },
  });
  if (!connection || connection.status !== 'ACTIVE') {
    throw new ConversionProviderError(
      'Meta needs to be reconnected before purchase sharing can continue',
      true,
      'META_CAPI_CONNECTION_INACTIVE',
    );
  }
  if (!connection.scopes.includes('ads_management')) {
    throw new ConversionProviderError(
      'Meta permission for purchase sharing is no longer available',
      true,
      'META_CAPI_PERMISSION_REQUIRED',
    );
  }
  if (connection.tokenExpiresAt && connection.tokenExpiresAt.getTime() <= Date.now()) {
    throw new ConversionProviderError(
      'Meta needs to be reconnected before purchase sharing can continue',
      true,
      'META_CAPI_REAUTH_REQUIRED',
    );
  }

  if (!config.adAccountId || !connection.selectedAdAccountIds.includes(config.adAccountId))
    throw new ConversionProviderError(
      'Selected Meta account no longer authorizes this destination',
      false,
      'META_DESTINATION_ACCOUNT_REVOKED',
    );
  return decryptSecret(connection.accessTokenCiphertext);
}

export async function deliverMetaPurchase(
  delivery: DeliveryClaim,
  beforeSend: BeforeConversionSend,
): Promise<ProviderDeliveryResult> {
  const userData = metaUserData(
    delivery.match ?? {},
    delivery.clickId,
    delivery.attributionEventAt ?? delivery.eventAt,
  );
  if (!delivery.clickId && !userData.fbp && !userData.em && !userData.external_id && !userData.ph) {
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
  endpoint.searchParams.set('access_token', await resolveMetaAccessToken(delivery));

  const body: Record<string, unknown> = {
    data: [
      {
        event_name: (
          {
            PAGE_VIEW: 'PageView',
            PRODUCT_VIEW: 'ViewContent',
            ADD_TO_CART: 'AddToCart',
            BEGIN_CHECKOUT: 'InitiateCheckout',
            PURCHASE: 'Purchase',
          } as Record<string, string>
        )[delivery.eventName ?? 'PURCHASE'],
        event_time: Math.floor(delivery.eventAt.getTime() / 1000),
        event_id: delivery.eventKey,
        action_source: 'website',
        ...(delivery.eventSourceUrl ? { event_source_url: delivery.eventSourceUrl } : {}),
        user_data: userData,
        custom_data: {
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
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ConversionProviderError(
      'Meta Conversions API request failed',
      true,
      'META_CAPI_NETWORK',
    );
  }

  const payload = await responseJson(response);
  if (!response.ok || payload.error) {
    const code = payload.error?.code ? String(payload.error.code) : String(response.status);
    const message = `Meta rejected conversion delivery (HTTP ${response.status})`;
    const retryable =
      response.status === 429 ||
      response.status >= 500 ||
      payload.error?.is_transient === true ||
      payload.error?.code === 190;
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
