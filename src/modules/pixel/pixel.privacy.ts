import {
  PIXEL_DEFAULT_RETENTION_DAYS,
  PIXEL_MAX_RETENTION_DAYS,
  type StorefrontAttributionInput,
  type StorefrontConsentState,
} from './pixel.types.js';

const DAY_MS = 24 * 60 * 60 * 1000;

type AttributionKey = keyof StorefrontAttributionInput;

const ATTRIBUTION_QUERY_KEYS: ReadonlyArray<[string, AttributionKey]> = [
  ['utm_source', 'utmSource'],
  ['utm_medium', 'utmMedium'],
  ['utm_campaign', 'utmCampaign'],
  ['utm_content', 'utmContent'],
  ['utm_term', 'utmTerm'],
  ['fbclid', 'metaClickId'],
  ['gclid', 'googleClickId'],
  ['ttclid', 'tiktokClickId'],
];

function truncate(value: string | null, maxLength: number): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, maxLength);
}

export function isStorefrontBehaviorCaptureAllowed(consentState: StorefrontConsentState) {
  return consentState === 'GRANTED' || consentState === 'NOT_REQUIRED';
}

export function sanitizeStorefrontUrl(value: string | null | undefined): string | null {
  if (!value) return null;

  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

    url.username = '';
    url.password = '';
    url.search = '';
    url.hash = '';

    return url.toString();
  } catch {
    return null;
  }
}

export function extractStorefrontAttribution(
  value: string | null | undefined,
): StorefrontAttributionInput {
  if (!value) return {};

  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return {};

    const attribution: StorefrontAttributionInput = {};

    for (const [queryKey, outputKey] of ATTRIBUTION_QUERY_KEYS) {
      const maxLength = outputKey.endsWith('ClickId') ? 512 : 255;
      const normalized = truncate(url.searchParams.get(queryKey), maxLength);
      if (normalized) attribution[outputKey] = normalized;
    }

    return attribution;
  } catch {
    return {};
  }
}

export function calculatePixelRetentionExpiresAt(
  receivedAt: Date,
  retentionDays = PIXEL_DEFAULT_RETENTION_DAYS,
): Date {
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < 1 ||
    retentionDays > PIXEL_MAX_RETENTION_DAYS
  ) {
    throw new RangeError(`retentionDays must be an integer between 1 and ${PIXEL_MAX_RETENTION_DAYS}`);
  }

  return new Date(receivedAt.getTime() + retentionDays * DAY_MS);
}
