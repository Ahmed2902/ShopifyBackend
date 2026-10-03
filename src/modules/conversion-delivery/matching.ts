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
export type BrowserMatchInput = { fbc?: string; fbp?: string; ttp?: string; userAgent?: string; clientIp?: string };
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
const countryCodes = new Set('ad ae af ag ai al am ao aq ar as at au aw ax az ba bb bd be bf bg bh bi bj bl bm bn bo bq br bs bt bv bw by bz ca cc cd cf cg ch ci ck cl cm cn co cr cu cv cw cx cy cz de dj dk dm do dz ec ee eg eh er es et fi fj fk fm fo fr ga gb gd ge gf gg gh gi gl gm gn gp gq gr gs gt gu gw gy hk hm hn hr ht hu id ie il im in io iq ir is it je jm jo jp ke kg kh ki km kn kp kr kw ky kz la lb lc li lk lr ls lt lu lv ly ma mc md me mf mg mh mk ml mm mn mo mp mq mr ms mt mu mv mw mx my mz na nc ne nf ng ni nl no np nr nu nz om pa pe pf pg ph pk pl pm pn pr ps pt pw py qa re ro rs ru rw sa sb sc sd se sg sh si sj sk sl sm sn so sr ss st sv sx sy sz tc td tf tg th tj tk tl tm tn to tr tt tv tw tz ua ug um us uy uz va vc ve vg vi vn vu wf ws ye yt za zm zw'.split(' '));
function country(value?: string | null) {
  const v = value?.trim().toLowerCase();
  return v && countryCodes.has(v) ? v : undefined;
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
    ['zp', text(input.postalCode)?.replace(/\s/gu, '').split('-')[0]],
    ['country', country(input.country)],
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
  const regionCode = country(input.country)?.toUpperCase();
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
  const cookieFbc = match.fbc && /^fb\.[0-2]\.\d{13}\.[A-Za-z0-9._~-]+$/.test(match.fbc) ? match.fbc : undefined;
  const fbc = clickId
    ? cookieFbc?.split('.').slice(3).join('.') === clickId
      ? cookieFbc
      : /^fb\.\d\.\d{13}\.[A-Za-z0-9._~-]+$/.test(clickId) ? clickId : `fb.1.${clickAt.getTime()}.${clickId}`
    : cookieFbc;
  return {
    ...(match.meta ?? {}),
    ...(match.fbp ? { fbp: match.fbp } : {}),
    ...(match.userAgent ? { client_user_agent: match.userAgent } : {}),
    ...(match.clientIp ? { client_ip_address: match.clientIp } : {}),
    ...(fbc ? { fbc } : {}),
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
    ...(match.clientIp ? { ip: match.clientIp } : {}),
    ...(clickId ? { ttclid: clickId } : {}),
  };
}
export function signalCoverage(match: MatchEvidence, provider: string, clickId: string | null): Record<string, boolean> {
  const fields = provider === 'META' ? match.meta : provider === 'TIKTOK' ? match.tiktok : undefined;
  return { clickId: Boolean(clickId || (provider === 'META' && match.fbc)), browserId: Boolean(provider === 'META' ? match.fbp : provider === 'TIKTOK' ? match.ttp : false),
    email: provider === 'GOOGLE_ADS' ? Boolean(match.google?.userIdentifiers.some(i => i.emailAddress)) : Boolean(fields?.em || fields?.email),
    phone: provider === 'GOOGLE_ADS' ? Boolean(match.google?.userIdentifiers.some(i => i.phoneNumber)) : Boolean(fields?.ph || fields?.phone),
    externalId: Boolean(fields?.external_id), ip: provider !== 'GOOGLE_ADS' && Boolean(match.clientIp), userAgent: provider !== 'GOOGLE_ADS' && Boolean(match.userAgent) };
}
