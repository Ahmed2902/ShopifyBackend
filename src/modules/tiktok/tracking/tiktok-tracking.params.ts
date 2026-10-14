import { createHash } from 'node:crypto';
import { AppError } from '../../../errors/app-error.js';
import { asRecord, asString } from '../tiktok.utils.js';

export const STANDARD_PARAMETERS = {
  metrico_tiktok_campaign_id: '__CAMPAIGN_ID__',
  metrico_tiktok_adgroup_id: '__AID__',
  metrico_tiktok_creative_id: '__CID__',
};
export const SMART_PARAMETERS = { ...STANDARD_PARAMETERS, metrico_tiktok_ad_id: '__ADID_V2__' };
export const manualTemplate = (smart = false) =>
  Object.entries(smart ? SMART_PARAMETERS : STANDARD_PARAMETERS)
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
export type Parameter = { key: string; value: string };
export function parameters(raw: unknown): Parameter[] {
  if (raw === undefined || raw === null) return [];
  if (!Array.isArray(raw))
    throw new AppError(
      'Sync this ad before installing tracking.',
      409,
      'TIKTOK_TRACKING_UNSUPPORTED',
    );
  return raw.map((item) => {
    const r = asRecord(item);
    if (
      typeof r.key !== 'string' ||
      typeof r.value !== 'string' ||
      !r.key ||
      Object.keys(r).some((k) => k !== 'key' && k !== 'value')
    )
      throw new AppError(
        'This tracking parameter format needs manual setup.',
        409,
        'TIKTOK_TRACKING_UNSUPPORTED',
      );
    return { key: r.key, value: r.value };
  });
}
export function desiredParameters(
  campaignId: string,
  groupId: string,
  adId: string,
): Record<string, string> {
  return {
    metrico_tiktok_campaign_id: campaignId,
    metrico_tiktok_adgroup_id: groupId,
    metrico_tiktok_ad_id: adId,
    metrico_tiktok_creative_id: '__CID__',
  };
}
export function mergeParameters(
  current: Parameter[],
  desired: Record<string, string>,
): Parameter[] {
  return [
    ...current.filter((p) => !Object.hasOwn(desired, p.key)),
    ...Object.entries(desired).map(([key, value]) => ({ key, value })),
  ];
}
export function trackingStatus(
  urls: string[],
  params: Parameter[],
  desired: Record<string, string>,
) {
  if (!urls.length) return 'MISSING' as const;
  const matches = urls.map((url) => {
    const combined = [
      ...new URL(url).searchParams.entries(),
      ...params.map((p) => [p.key, p.value]),
    ];
    return Object.entries(desired).map(([key, value]) => {
      const found = combined.filter((p) => p[0] === key).map((p) => p[1]);
      const macro =
        key === 'metrico_tiktok_campaign_id'
          ? '__CAMPAIGN_ID__'
          : key === 'metrico_tiktok_adgroup_id'
            ? '__AID__'
            : key === 'metrico_tiktok_ad_id'
              ? '__ADID_V2__'
              : '__CID__';
      return found.length === 1 && (found[0] === value || found[0] === macro);
    });
  });
  if (matches.every((row) => row.every(Boolean))) return 'EXACT' as const;
  const present =
    urls.some((url) =>
      [...new URL(url).searchParams.keys()].some((k) => Object.hasOwn(desired, k)),
    ) || params.some((p) => Object.hasOwn(desired, p.key));
  return present ? ('PARTIAL' as const) : ('MISSING' as const);
}
export function cleanUrl(raw: unknown): string {
  const value = asString(raw);
  let url: URL;
  try {
    url = new URL(value ?? '');
  } catch {
    throw new AppError(
      'This ad needs a website destination for automatic setup.',
      409,
      'TIKTOK_TRACKING_UNSUPPORTED',
    );
  }
  if (
    !['https:', 'http:'].includes(url.protocol) ||
    url.username ||
    url.password ||
    [...url.searchParams.keys()].some((k) =>
      /^(signature|sig|x-amz-signature|x-goog-signature)$/i.test(k),
    )
  )
    throw new AppError(
      'This destination requires manual tracking setup.',
      409,
      'TIKTOK_TRACKING_UNSUPPORTED',
    );
  // Preserve the merchant's original encoding, macros and fragment byte-for-byte.
  return value!;
}
export function removeOwnedUrlParameters(raw: string, desired: Record<string, string>): string {
  const [base, fragment] = raw.split(/#(.*)/s);
  const question = base!.indexOf('?');
  if (question < 0) return raw;
  const parts = base!
    .slice(question + 1)
    .split('&')
    .filter((part) => {
      try {
        return !Object.hasOwn(desired, decodeURIComponent(part.split('=')[0]!.replace(/\+/g, ' ')));
      } catch {
        throw new AppError(
          'This URL contains malformed tracking parameters.',
          409,
          'TIKTOK_TRACKING_UNSUPPORTED',
        );
      }
    });
  return (
    base!.slice(0, question) +
    (parts.join('&') ? `?${parts.join('&')}` : '') +
    (fragment === undefined ? '' : `#${fragment}`)
  );
}
export const snapshotHash = (value: unknown) =>
  createHash('sha256').update(JSON.stringify(value)).digest('hex');
