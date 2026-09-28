import { env } from '../../../config/env.js';
import type {
  ConversionProviderAdapter,
  ConversionProviderSendInput,
  ConversionProviderSendResult,
} from '../conversion-delivery.types.js';
import { ConversionProviderError } from '../conversion-delivery.types.js';

const META_TIMEOUT_MS = 15_000;
const TRANSIENT_GRAPH_CODES = new Set([1, 2, 4, 17, 32, 341, 613]);
const INVALID_DESTINATION_CODES = new Set([10, 190, 200]);

type MetaResponse = {
  events_received?: unknown;
  fbtrace_id?: unknown;
  error?: { code?: unknown; message?: unknown; error_subcode?: unknown; fbtrace_id?: unknown };
};

function asRequestId(payload: MetaResponse | null): string | null {
  const value = payload?.fbtrace_id ?? payload?.error?.fbtrace_id;
  return typeof value === 'string' && value ? value : null;
}

function numeric(value: string | null): number | undefined {
  if (value === null) return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

export class MetaConversionProvider implements ConversionProviderAdapter {
  readonly provider = 'META' as const;

  async send(input: ConversionProviderSendInput): Promise<ConversionProviderSendResult> {
    const token = input.destination.secret;
    if (!token) {
      throw new ConversionProviderError('Meta Conversions API access token is missing', {
        code: 'META_CAPI_TOKEN_MISSING',
        retryable: false,
        destinationInvalid: true,
      });
    }
    if (input.event.matchKeyKind !== 'FBC') {
      throw new ConversionProviderError('Meta conversion does not have a Meta click identifier', {
        code: 'META_CAPI_MATCH_KEY_MISSING',
        retryable: false,
      });
    }

    const contents = input.event.contents.map((item) => ({
      id: item.contentId,
      quantity: item.quantity,
      ...(numeric(item.price) === undefined ? {} : { item_price: numeric(item.price) }),
    }));
    const contentIds = contents.map((item) => item.id);

    const payload = {
      data: [
        {
          event_name: 'Purchase',
          event_time: Math.floor(input.event.eventAt.getTime() / 1000),
          event_id: input.event.eventId,
          action_source: 'website',
          event_source_url: input.event.sourceUrl,
          user_data: { fbc: input.event.matchKey },
          custom_data: {
            value: Number(input.event.value),
            currency: input.event.currencyCode,
            order_id: input.event.orderId,
            content_type: 'product',
            ...(contentIds.length === 0 ? {} : { content_ids: contentIds, contents }),
          },
        },
      ],
      ...(input.destination.testEventCode
        ? { test_event_code: input.destination.testEventCode }
        : {}),
    };

    const url = `https://graph.facebook.com/${env.META_API_VERSION}/${encodeURIComponent(input.destination.destinationExternalId)}/events`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(META_TIMEOUT_MS),
      });
    } catch {
      throw new ConversionProviderError('Meta Conversions API could not be reached', {
        code: 'META_CAPI_NETWORK_ERROR',
        retryable: true,
      });
    }

    const parsed = (await response.json().catch(() => null)) as MetaResponse | null;
    const requestId = asRequestId(parsed);
    const graphCode = typeof parsed?.error?.code === 'number' ? parsed.error.code : null;
    const eventsReceived =
      typeof parsed?.events_received === 'number' ? parsed.events_received : Number(parsed?.events_received);

    if (response.ok && Number.isFinite(eventsReceived) && eventsReceived >= 1) {
      return { requestId };
    }

    const retryable =
      response.status === 408 ||
      response.status === 429 ||
      response.status >= 500 ||
      (graphCode !== null && TRANSIENT_GRAPH_CODES.has(graphCode));
    const destinationInvalid =
      response.status === 401 ||
      response.status === 403 ||
      (graphCode !== null && INVALID_DESTINATION_CODES.has(graphCode));

    throw new ConversionProviderError(
      typeof parsed?.error?.message === 'string'
        ? `Meta Conversions API rejected the event: ${parsed.error.message}`
        : 'Meta Conversions API rejected the event',
      {
        code: destinationInvalid ? 'META_CAPI_DESTINATION_INVALID' : 'META_CAPI_REJECTED',
        retryable,
        destinationInvalid,
        httpStatus: response.status,
        requestId,
      },
    );
  }
}
