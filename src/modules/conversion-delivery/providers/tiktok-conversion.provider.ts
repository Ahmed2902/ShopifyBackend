import type {
  ConversionProviderAdapter,
  ConversionProviderSendInput,
  ConversionProviderSendResult,
} from '../conversion-delivery.types.js';
import { ConversionProviderError } from '../conversion-delivery.types.js';

const TIKTOK_EVENTS_URL = 'https://business-api.tiktok.com/open_api/v1.3/event/track/';
const TIKTOK_TIMEOUT_MS = 15_000;

type TikTokResponse = {
  code?: unknown;
  message?: unknown;
  request_id?: unknown;
};

function numeric(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export class TikTokConversionProvider implements ConversionProviderAdapter {
  readonly provider = 'TIKTOK' as const;

  async send(input: ConversionProviderSendInput): Promise<ConversionProviderSendResult> {
    const token = input.destination.secret;
    if (!token) {
      throw new ConversionProviderError('TikTok Events API access token is missing', {
        code: 'TIKTOK_EVENTS_TOKEN_MISSING',
        retryable: false,
        destinationInvalid: true,
      });
    }
    if (input.event.matchKeyKind !== 'TTCLID') {
      throw new ConversionProviderError('TikTok conversion does not have a TikTok click identifier', {
        code: 'TIKTOK_EVENTS_MATCH_KEY_MISSING',
        retryable: false,
      });
    }

    const contents = input.event.contents.map((item) => ({
      content_id: item.contentId,
      content_type: 'product',
      quantity: item.quantity,
      ...(numeric(item.price) === undefined ? {} : { price: numeric(item.price) }),
    }));

    const payload = {
      event_source: 'web',
      event_source_id: input.destination.destinationExternalId,
      data: [
        {
          event: 'Purchase',
          event_time: Math.floor(input.event.eventAt.getTime() / 1000),
          event_id: input.event.eventId,
          user: { ttclid: input.event.matchKey },
          page: { url: input.event.sourceUrl },
          properties: {
            value: Number(input.event.value),
            currency: input.event.currencyCode,
            order_id: input.event.orderId,
            content_type: 'product',
            ...(contents.length === 0 ? {} : { contents }),
          },
        },
      ],
      ...(input.destination.testEventCode
        ? { test_event_code: input.destination.testEventCode }
        : {}),
    };

    let response: Response;
    try {
      response = await fetch(TIKTOK_EVENTS_URL, {
        method: 'POST',
        headers: {
          'Access-Token': token,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(TIKTOK_TIMEOUT_MS),
      });
    } catch {
      throw new ConversionProviderError('TikTok Events API could not be reached', {
        code: 'TIKTOK_EVENTS_NETWORK_ERROR',
        retryable: true,
      });
    }

    const parsed = (await response.json().catch(() => null)) as TikTokResponse | null;
    const requestId =
      typeof parsed?.request_id === 'string' && parsed.request_id ? parsed.request_id : null;
    const providerCode = typeof parsed?.code === 'number' ? parsed.code : null;

    if (response.ok && providerCode === 0) return { requestId };

    const message = typeof parsed?.message === 'string' ? parsed.message : 'TikTok Events API rejected the event';
    const normalizedMessage = message.toLowerCase();
    const destinationInvalid =
      response.status === 401 ||
      response.status === 403 ||
      normalizedMessage.includes('access token') ||
      normalizedMessage.includes('permission') ||
      normalizedMessage.includes('event source') ||
      normalizedMessage.includes('pixel');
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;

    throw new ConversionProviderError(`TikTok Events API rejected the event: ${message}`, {
      code: destinationInvalid ? 'TIKTOK_EVENTS_DESTINATION_INVALID' : 'TIKTOK_EVENTS_REJECTED',
      retryable,
      destinationInvalid,
      httpStatus: response.status,
      requestId,
    });
  }
}
