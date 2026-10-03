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
  ['gbraid', 'googleBraidedClickId'],
  ['wbraid', 'googleWebBraidedClickId'],
  ['ttclid', 'tiktokClickId'],
  ['stride_meta_campaign_id', 'metaCampaignExternalId'],
  ['stride_meta_adset_id', 'metaAdSetExternalId'],
  ['stride_meta_ad_id', 'metaAdExternalId'],
];

function truncate(value: string | null, maxLength: number): string | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;
  return normalized.slice(0, maxLength);
}

// Named parameters can still be misused to carry PII. Reject email/URL/control-like values
// rather than retaining arbitrary query contents under an attribution label.
export function sanitizeAttributionValue(
  value: string | null | undefined,
  click = false,
): string | undefined {
  const v = value?.trim();
  if (!v || v.includes('@') || /https?:\/\//i.test(v) || [...v].some((c) => c.charCodeAt(0) < 32))
    return undefined;
  if (click && !/^[A-Za-z0-9._~-]+$/.test(v)) return undefined;
  return v;
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
    if (/^\/(?:checkouts?|account)(?:\/|$)/i.test(url.pathname))
      url.pathname = '/' + url.pathname.split('/')[1];
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
      const raw = url.searchParams.get(queryKey)?.trim();
      if (!raw) continue;

      if (outputKey.endsWith('ExternalId')) {
        if (raw.length > 128 || !/^\d+$/.test(raw)) continue;
        attribution[outputKey] = raw;
        continue;
      }

      const maxLength = outputKey.endsWith('ClickId') ? 512 : 255;
      const normalized = sanitizeAttributionValue(
        truncate(raw, maxLength),
        outputKey.endsWith('ClickId'),
      );
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
    throw new RangeError(
      `retentionDays must be an integer between 1 and ${PIXEL_MAX_RETENTION_DAYS}`,
    );
  }

  return new Date(receivedAt.getTime() + retentionDays * DAY_MS);
}
