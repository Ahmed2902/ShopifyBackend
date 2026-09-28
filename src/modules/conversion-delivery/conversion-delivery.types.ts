export type ConversionProviderCode = 'META' | 'TIKTOK' | 'GOOGLE_ADS';
export type ConversionMatchKey = 'FBC' | 'TTCLID' | 'GCLID' | 'GBRAID' | 'WBRAID';
export type ConversionConsent = 'GRANTED' | 'NOT_REQUIRED';

export type ConversionLineItem = {
  contentId: string;
  quantity: number;
  price: string | null;
};

export type ConversionProviderDestination = {
  provider: ConversionProviderCode;
  accountExternalId: string;
  destinationExternalId: string;
  secret: string | null;
  testEventCode: string | null;
};

export type ConversionProviderEvent = {
  eventId: string;
  orderId: string;
  eventAt: Date;
  sourceEventAt: Date;
  sourceUrl: string;
  value: string;
  currencyCode: string;
  matchKeyKind: ConversionMatchKey;
  matchKey: string;
  consentState: ConversionConsent;
  contents: ConversionLineItem[];
};

export type ConversionProviderSendInput = {
  storeId: string;
  destination: ConversionProviderDestination;
  event: ConversionProviderEvent;
};

export type ConversionProviderSendResult = {
  requestId: string | null;
};

export interface ConversionProviderAdapter {
  readonly provider: ConversionProviderCode;
  send(input: ConversionProviderSendInput): Promise<ConversionProviderSendResult>;
}

export class ConversionProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly destinationInvalid: boolean;
  readonly httpStatus: number | null;
  readonly requestId: string | null;

  constructor(
    message: string,
    input: {
      code: string;
      retryable: boolean;
      destinationInvalid?: boolean;
      httpStatus?: number | null;
      requestId?: string | null;
    },
  ) {
    super(message);
    this.name = 'ConversionProviderError';
    this.code = input.code;
    this.retryable = input.retryable;
    this.destinationInvalid = input.destinationInvalid ?? false;
    this.httpStatus = input.httpStatus ?? null;
    this.requestId = input.requestId ?? null;
  }
}
