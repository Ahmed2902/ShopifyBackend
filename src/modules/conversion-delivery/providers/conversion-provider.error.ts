export class ConversionProviderError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly providerCode?: string,
  ) {
    super(message);
    this.name = 'ConversionProviderError';
  }
}

export class ConversionConsentWithdrawnError extends ConversionProviderError {
  constructor() {
    super('Advertising consent is missing or withdrawn', false, 'CONVERSION_CONSENT_WITHDRAWN');
    this.name = 'ConversionConsentWithdrawnError';
  }
}

export function providerErrorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return 'Unknown conversion provider error';
}

export class ConversionEntitlementChangedError extends ConversionProviderError {
  constructor() { super('The current subscription no longer authorizes this provider', true, 'CONVERSION_ENTITLEMENT_CHANGED'); }
}
