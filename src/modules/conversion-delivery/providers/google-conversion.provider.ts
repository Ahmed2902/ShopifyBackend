import { AppError } from '../../../errors/app-error.js';
import { GoogleAdsRepository } from '../../google-ads/google-ads.repository.js';
import { GoogleAdsAuthService } from '../../google-ads/shared/google-ads-auth.service.js';
import { GoogleAdsApiService } from '../../google-ads/shared/google-ads-api.service.js';
import type {
  BeforeConversionSend,
  ConversionDestinationConfig,
  DeliveryClaim,
  ProviderDeliveryResult,
} from '../conversion-delivery.types.js';
import { GOOGLE_DATA_MANAGER_SCOPE } from '../conversion-delivery.types.js';
import { ConversionProviderError } from './conversion-provider.error.js';

const REQUEST_TIMEOUT_MS = 10_000;
const GOOGLE_DATA_MANAGER_ENDPOINT = 'https://datamanager.googleapis.com/v1/events:ingest';

const repository = new GoogleAdsRepository();
const api = new GoogleAdsApiService();
const auth = new GoogleAdsAuthService(repository, api);

type GoogleDataManagerResponse = {
  requestId?: string;
  fieldWarnings?: Array<{ field?: string; message?: string }>;
  error?: { code?: number; status?: string; message?: string };
};

async function responseJson(response: Response): Promise<GoogleDataManagerResponse> {
  try {
    return (await response.json()) as GoogleDataManagerResponse;
  } catch {
    return {};
  }
}

function configFor(delivery: DeliveryClaim) {
  const config = (delivery.destination.configJson ?? {}) as ConversionDestinationConfig;
  if (!config.customerId) {
    throw new ConversionProviderError(
      'Google conversion destination is missing the operating Google Ads customer ID',
      false,
      'GOOGLE_DATA_MANAGER_CUSTOMER_MISSING',
    );
  }
  return config;
}

export async function deliverGooglePurchase(
  delivery: DeliveryClaim,
  beforeSend: BeforeConversionSend,
): Promise<ProviderDeliveryResult> {
  if (delivery.eventName && delivery.eventName !== 'PURCHASE')
    throw new ConversionProviderError(
      'Google Ads requires an explicitly configured conversion action',
      false,
      'GOOGLE_FUNNEL_UNSUPPORTED',
    );
  if (!delivery.clickId && !delivery.match?.google) {
    throw new ConversionProviderError(
      'Google Purchase has no consented gclid match identifier',
      false,
      'GOOGLE_MATCH_ID_MISSING',
    );
  }

  const config = configFor(delivery);
  let context;
  try {
    context = await auth.getApiContext(delivery.storeId);
  } catch (error) {
    if (error instanceof AppError) {
      throw new ConversionProviderError(error.message, false, error.code);
    }
    throw error;
  }
  if (!context.scopes.includes(GOOGLE_DATA_MANAGER_SCOPE)) {
    throw new ConversionProviderError(
      'Google Ads must be reconnected once to grant the Data Manager conversion-ingestion scope',
      false,
      'GOOGLE_DATA_MANAGER_SCOPE_REQUIRED',
    );
  }

  if (context.selectedCustomerIds && !context.selectedCustomerIds.includes(config.customerId!))
    throw new ConversionProviderError(
      'Selected Google Ads account no longer authorizes this destination',
      false,
      'GOOGLE_DESTINATION_ACCOUNT_REVOKED',
    );
  const destination = {
    operatingAccount: {
      accountType: 'GOOGLE_ADS',
      accountId: config.customerId,
    },
    loginAccount: {
      accountType: 'GOOGLE_ADS',
      accountId: config.loginCustomerId ?? config.customerId,
    },
    productDestinationId: delivery.destination.externalId,
  };

  const body: Record<string, unknown> = {
    destinations: [destination],
    events: [
      {
        transactionId: delivery.shopifyOrderId,
        eventTimestamp: delivery.eventAt.toISOString(),
        eventSource: 'WEB',
        ...(delivery.clickId
          ? {
              adIdentifiers: {
                [delivery.clickIdKind &&
                ['gclid', 'gbraid', 'wbraid'].includes(delivery.clickIdKind)
                  ? delivery.clickIdKind
                  : 'gclid']: delivery.clickId,
              },
            }
          : {}),
        ...(delivery.match?.google ? { userData: delivery.match.google } : {}),
        conversionValue: Number(delivery.value),
        currency: delivery.currencyCode,
      },
    ],
    validateOnly: false,
    ...(delivery.match?.google ? { encoding: 'HEX' } : {}),
  };
  if (config.googleConsentMode === 'GRANTED' || delivery.sourceEventId) {
    body.consent = {
      adUserData: 'CONSENT_GRANTED',
      adPersonalization: 'CONSENT_GRANTED',
    };
  }

  // OAuth refresh can take place above. Recheck durable permission after it finishes.
  await beforeSend();
  let response: Response;
  try {
    response = await fetch(GOOGLE_DATA_MANAGER_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${context.accessToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch {
    throw new ConversionProviderError(
      'Google Data Manager conversion request failed',
      true,
      'GOOGLE_DATA_MANAGER_NETWORK',
    );
  }

  const payload = await responseJson(response);
  if (!response.ok || payload.error) {
    const code =
      payload.error?.status ??
      (payload.error?.code ? String(payload.error.code) : String(response.status));
    const message = `Google Data Manager rejected conversion delivery (HTTP ${response.status})`;
    const retryable = response.status === 429 || response.status >= 500;
    throw new ConversionProviderError(message, retryable, code);
  }
  if (!payload.requestId) {
    throw new ConversionProviderError(
      'Google Data Manager accepted the request without returning a request ID',
      true,
      'GOOGLE_DATA_MANAGER_REQUEST_ID_MISSING',
    );
  }

  return { providerRequestId: payload.requestId };
}
