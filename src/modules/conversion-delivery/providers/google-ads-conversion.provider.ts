import { env } from '../../../config/env.js';
import { AppError } from '../../../errors/app-error.js';
import { prisma } from '../../../lib/prisma.js';
import { GoogleAdsRepository } from '../../google-ads/google-ads.repository.js';
import { normalizeCustomerId } from '../../google-ads/google-ads.utils.js';
import { GoogleAdsApiService } from '../../google-ads/shared/google-ads-api.service.js';
import { GoogleAdsAuthService } from '../../google-ads/shared/google-ads-auth.service.js';
import type {
  ConversionProviderAdapter,
  ConversionProviderSendInput,
  ConversionProviderSendResult,
} from '../conversion-delivery.types.js';
import { ConversionProviderError } from '../conversion-delivery.types.js';

const GOOGLE_TIMEOUT_MS = 15_000;

type GoogleUploadResponse = {
  partialFailureError?: { message?: unknown; status?: unknown; code?: unknown };
  results?: unknown[];
};

function googleDateTime(date: Date): string {
  return `${date.toISOString().slice(0, 19).replace('T', ' ')}+00:00`;
}

function conversionActionId(value: string): string {
  const id = value.split('/').filter(Boolean).at(-1) ?? '';
  if (!/^\d+$/.test(id)) {
    throw new ConversionProviderError('Google Ads conversion action ID is invalid', {
      code: 'GOOGLE_CONVERSION_ACTION_INVALID',
      retryable: false,
      destinationInvalid: true,
    });
  }
  return id;
}

function safeGoogleMessage(payload: GoogleUploadResponse | null): string {
  const message = payload?.partialFailureError?.message;
  return typeof message === 'string' && message ? message : 'Google Ads rejected the conversion';
}

export class GoogleAdsConversionProvider implements ConversionProviderAdapter {
  readonly provider = 'GOOGLE_ADS' as const;
  private readonly repository = new GoogleAdsRepository();
  private readonly api = new GoogleAdsApiService();
  private readonly auth = new GoogleAdsAuthService(this.repository, this.api);

  async send(input: ConversionProviderSendInput): Promise<ConversionProviderSendResult> {
    if (!env.GOOGLE_ADS_DEVELOPER_TOKEN) {
      throw new ConversionProviderError('Google Ads developer token is not configured', {
        code: 'GOOGLE_ADS_NOT_CONFIGURED',
        retryable: false,
        destinationInvalid: true,
      });
    }
    if (!['GCLID', 'GBRAID', 'WBRAID'].includes(input.event.matchKeyKind)) {
      throw new ConversionProviderError('Google Ads conversion does not have a Google click identifier', {
        code: 'GOOGLE_ADS_MATCH_KEY_MISSING',
        retryable: false,
      });
    }

    let context: Awaited<ReturnType<GoogleAdsAuthService['getApiContext']>>;
    try {
      context = await this.auth.getApiContext(input.storeId);
    } catch (error) {
      throw new ConversionProviderError(
        error instanceof Error ? error.message : 'Google Ads connection is unavailable',
        {
          code: error instanceof AppError ? error.code : 'GOOGLE_ADS_CONNECTION_UNAVAILABLE',
          retryable: false,
          destinationInvalid: true,
        },
      );
    }

    const customerId = normalizeCustomerId(input.destination.accountExternalId);
    if (!context.selectedCustomerIds.map(normalizeCustomerId).includes(customerId)) {
      throw new ConversionProviderError('Google Ads customer is no longer selected for this store', {
        code: 'GOOGLE_ADS_CUSTOMER_NOT_SELECTED',
        retryable: false,
        destinationInvalid: true,
      });
    }

    const customer = await prisma.googleAdsCustomer.findUnique({
      where: { storeId_customerId: { storeId: input.storeId, customerId } },
      select: { loginCustomerId: true },
    });
    const actionId = conversionActionId(input.destination.destinationExternalId);
    const clickIdentifier =
      input.event.matchKeyKind === 'GCLID'
        ? { gclid: input.event.matchKey }
        : input.event.matchKeyKind === 'GBRAID'
          ? { gbraid: input.event.matchKey }
          : { wbraid: input.event.matchKey };

    const conversion = {
      ...clickIdentifier,
      conversionAction: `customers/${customerId}/conversionActions/${actionId}`,
      conversionDateTime: googleDateTime(input.event.eventAt),
      conversionValue: Number(input.event.value),
      currencyCode: input.event.currencyCode,
      orderId: input.event.orderId,
      ...(input.event.consentState === 'GRANTED'
        ? { consent: { adUserData: 'GRANTED', adPersonalization: 'GRANTED' } }
        : {}),
    };

    const url = `https://googleads.googleapis.com/${context.apiVersion}/customers/${customerId}:uploadClickConversions`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${context.accessToken}`,
          'Content-Type': 'application/json',
          'developer-token': env.GOOGLE_ADS_DEVELOPER_TOKEN,
          ...(customer?.loginCustomerId
            ? { 'login-customer-id': normalizeCustomerId(customer.loginCustomerId) }
            : {}),
        },
        body: JSON.stringify({
          conversions: [conversion],
          partialFailure: true,
          validateOnly: false,
        }),
        signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
      });
    } catch {
      throw new ConversionProviderError('Google Ads conversion upload could not be reached', {
        code: 'GOOGLE_ADS_CONVERSION_NETWORK_ERROR',
        retryable: true,
      });
    }

    const parsed = (await response.json().catch(() => null)) as GoogleUploadResponse | null;
    const requestId = response.headers.get('request-id');
    if (response.ok && !parsed?.partialFailureError) return { requestId };

    const message = safeGoogleMessage(parsed);
    const normalized = message.toLowerCase();
    const destinationInvalid =
      response.status === 401 ||
      response.status === 403 ||
      normalized.includes('conversion action') ||
      normalized.includes('customer') ||
      normalized.includes('permission') ||
      normalized.includes('developer token');
    const retryable = response.status === 408 || response.status === 429 || response.status >= 500;

    throw new ConversionProviderError(`Google Ads conversion upload failed: ${message}`, {
      code: destinationInvalid ? 'GOOGLE_ADS_CONVERSION_DESTINATION_INVALID' : 'GOOGLE_ADS_CONVERSION_REJECTED',
      retryable,
      destinationInvalid,
      httpStatus: response.status,
      requestId,
    });
  }
}
