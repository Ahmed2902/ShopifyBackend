import { tiktokProperties } from '../conversion-content.js';
import { assertCanonicalPurchase } from './conversion-event.validation.js';
import { tiktokUserData } from '../matching.js';
import { decryptSecret } from '../../integrations/integration.utils.js';
import type {
  BeforeConversionSend,
  ConversionDestinationConfig,
  DeliveryClaim,
  ProviderDeliveryResult,
} from '../conversion-delivery.types.js';
import { ConversionProviderError } from './conversion-provider.error.js';
import { env } from '../../../config/env.js';
import { AppError } from '../../../errors/app-error.js';
import { TikTokRepository } from '../../tiktok/tiktok.repository.js';
import { TikTokAuthService } from '../../tiktok/shared/tiktok-auth.service.js';
import { TikTokApiService } from '../../tiktok/shared/tiktok-api.service.js';
import { listTikTokPixels } from '../tiktok-pixels.js';

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
  assertCanonicalPurchase(delivery);
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
  const config = (delivery.destination.configJson ?? {}) as ConversionDestinationConfig;
  const tokenCiphertext = delivery.destination.accessTokenCiphertext;
  let accessToken: string;
  if (config.authSource === 'TIKTOK_CONNECTION') {
    if (!env.TIKTOK_EVENTS_API_ENABLED)
      throw new ConversionProviderError(
        'TikTok Events API is not approved for this deployment',
        true,
        'TIKTOK_EVENTS_APPROVAL_REQUIRED',
      );
    try {
      const api = new TikTokApiService();
      const context = await new TikTokAuthService(new TikTokRepository(), api).getApiContext(
        delivery.storeId,
      );
      if (!config.advertiserId || !context.selectedAdvertiserIds.includes(config.advertiserId))
        throw new ConversionProviderError(
          'TikTok advertiser no longer authorizes this destination',
          false,
          'TIKTOK_DESTINATION_ACCOUNT_REVOKED',
        );
      const pixels = await listTikTokPixels(api, context, config.advertiserId);
      if (!pixels.some((pixel) => pixel.code === delivery.destination.externalId))
        throw new ConversionProviderError(
          'TikTok destination no longer belongs to the selected advertiser',
          false,
          'TIKTOK_DESTINATION_REVOKED',
        );
      accessToken = context.accessToken;
    } catch (error) {
      if (error instanceof ConversionProviderError) throw error;
      if (
        error instanceof AppError &&
        ['TIKTOK_REAUTH_REQUIRED', 'TIKTOK_CONNECTION_INACTIVE', 'TIKTOK_NOT_CONNECTED'].includes(
          error.code,
        )
      )
        throw new ConversionProviderError(
          'Reconnect TikTok before sharing purchases',
          true,
          'TIKTOK_REAUTH_REQUIRED',
        );
      throw new ConversionProviderError(
        'TikTok destination authorization could not be verified',
        true,
        'TIKTOK_DESTINATION_CHECK_FAILED',
      );
    }
  } else if (tokenCiphertext) {
    accessToken = decryptSecret(tokenCiphertext);
  } else {
    throw new ConversionProviderError(
      'TikTok Events API destination is missing an Events Manager access token',
      false,
      'TIKTOK_EVENTS_TOKEN_MISSING',
    );
  }
  const user = tiktokUserData(delivery.match ?? {}, delivery.clickId);
  if (
    !delivery.clickId &&
    !user.ttp &&
    !user.email &&
    !user.phone &&
    !user.external_id &&
    !(user.ip && user.user_agent)
  ) {
    throw new ConversionProviderError(
      'TikTok event has no permitted supported matching identifier',
      false,
      'TIKTOK_MATCH_ID_MISSING',
    );
  }

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
        properties: tiktokProperties(delivery),
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
        'Access-Token': accessToken,
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
