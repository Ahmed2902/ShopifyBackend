import { createHash, createHmac } from 'node:crypto';

export type CustomerMatchInput = {
  emails?: Array<string | null>;
  phones?: Array<string | null>;
  firstName?: string | null;
  lastName?: string | null;
  city?: string | null;
  region?: string | null;
  postalCode?: string | null;
  country?: string | null;
  externalId?: string | null;
};
export type BrowserMatchInput = { fbp?: string; ttp?: string; userAgent?: string };
export type MatchEvidence = BrowserMatchInput & {
  meta?: Record<string, unknown>;
  tiktok?: Record<string, unknown>;
  google?: { userIdentifiers: Array<Record<string, unknown>> };
};
export function sha256(value: string) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}
export function customerIdentity(secret: string, storeId: string, shopifyCustomerId: string) {
  return createHmac('sha256', secret)
    .update(JSON.stringify(['stride-customer-v1', storeId, shopifyCustomerId]))
    .digest('hex');
}
function text(value?: string | null) {
  const v = value?.trim().toLowerCase();
  return v || undefined;
}
function name(value?: string | null) {
  return text(value)?.replace(/[\p{P}\p{S}\p{N}]/gu, '') || undefined;
}
function compact(value?: string | null) {
  return text(value)?.replace(/[\s\p{P}\p{S}]/gu, '') || undefined;
}
function email(value?: string | null, google = false) {
  const v = google ? text(value)?.replace(/\s/gu, '') : text(value);
  if (!v || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/u.test(v)) return undefined;
  const [local, domain] = v.split('@');
  return google && ['gmail.com', 'googlemail.com'].includes(domain!)
    ? `${local!.split('+')[0]!.replace(/\./g, '')}@${domain}`
    : v;
}
// Do not guess the country of a national phone number. Canonical Shopify phones use E.164.
function phone(value?: string | null) {
  const v = value?.trim().replace(/[\s().-]/g, '');
  return v && /^\+[1-9]\d{6,14}$/.test(v) ? v : undefined;
}
function hashes(
  values: Array<string | null> | undefined,
  normalize: (value: string | null) => string | undefined,
) {
  return [
    ...new Set(
      (values ?? [])
        .map(normalize)
        .filter((v): v is string => Boolean(v))
        .map(sha256),
    ),
  ].slice(0, 10);
}
export function normalizeCustomerMatching(input: CustomerMatchInput): MatchEvidence {
  const em = hashes(input.emails, (v) => email(v));
  const ph = hashes(input.phones, (v) => phone(v)?.slice(1));
  const meta: Record<string, unknown> = {};
  const tiktok: Record<string, unknown> = {};
  if (em.length) {
    meta.em = em;
    tiktok.email = em[0];
  }
  if (ph.length) meta.ph = ph;
  const ttPhone = hashes(input.phones, (v) => phone(v));
  if (ttPhone.length) tiktok.phone = ttPhone[0];
  for (const [key, v] of [
    ['fn', name(input.firstName)],
    ['ln', name(input.lastName)],
    ['ct', compact(input.city)],
    ['st', compact(input.region)],
    ['zp', compact(input.postalCode)],
    ['country', /^[a-z]{2}$/.test(text(input.country) ?? '') ? text(input.country) : undefined],
  ] as const)
    if (v) meta[key] = [sha256(v)];
  if (input.externalId) {
    meta.external_id = [sha256(input.externalId)];
    tiktok.external_id = sha256(input.externalId);
  }
  const identifiers: Array<Record<string, unknown>> = [
    ...hashes(input.emails, (v) => email(v, true)).map((emailAddress) => ({ emailAddress })),
    ...hashes(input.phones, (v) => phone(v)).map((phoneNumber) => ({ phoneNumber })),
  ];
  const givenName = name(input.firstName);
  const familyName = name(input.lastName);
  const regionCode = input.country?.trim().toUpperCase();
  const postalCode = input.postalCode?.trim();
  if (givenName && familyName && regionCode && /^[A-Z]{2}$/.test(regionCode) && postalCode)
    identifiers.push({
      address: {
        givenName: sha256(givenName),
        familyName: sha256(familyName),
        regionCode,
        postalCode,
      },
    });
  return {
    ...(Object.keys(meta).length ? { meta } : {}),
    ...(Object.keys(tiktok).length ? { tiktok } : {}),
    ...(identifiers.length ? { google: { userIdentifiers: identifiers.slice(0, 10) } } : {}),
  };
}
export function metaUserData(
  match: MatchEvidence,
  clickId: string | null,
  clickAt: Date,
): Record<string, unknown> {
  return {
    ...(match.meta ?? {}),
    ...(match.fbp ? { fbp: match.fbp } : {}),
    ...(match.userAgent ? { client_user_agent: match.userAgent } : {}),
    ...(clickId
      ? { fbc: clickId.startsWith('fb.') ? clickId : `fb.1.${clickAt.getTime()}.${clickId}` }
      : {}),
  };
}
export function tiktokUserData(
  match: MatchEvidence,
  clickId: string | null,
): Record<string, unknown> {
  return {
    ...(match.tiktok ?? {}),
    ...(match.ttp ? { ttp: match.ttp } : {}),
    ...(match.userAgent ? { user_agent: match.userAgent } : {}),
    ...(clickId ? { ttclid: clickId } : {}),
  };
}
export function signalCoverage(
  match: MatchEvidence,
  provider: string,
  clickId: string | null,
): Record<string, boolean> {
  const fields =
    provider === 'META' ? match.meta : provider === 'TIKTOK' ? match.tiktok : undefined;
  return {
    clickId: Boolean(clickId),
    browserId: Boolean(provider === 'META' ? match.fbp : provider === 'TIKTOK' ? match.ttp : false),
    email: Boolean(
      fields?.em || fields?.email || match.google?.userIdentifiers.some((i) => i.emailAddress),
    ),
    phone: Boolean(
      fields?.ph || fields?.phone || match.google?.userIdentifiers.some((i) => i.phoneNumber),
    ),
    externalId: Boolean(fields?.external_id),
    ip: false,
    userAgent: Boolean(match.userAgent),
  };
}
