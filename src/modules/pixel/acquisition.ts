export const ACQUISITION_VERSION = 1;
export const ACQUISITION_CHANNELS = [
  'PAID_SOCIAL',
  'PAID_SEARCH',
  'ORGANIC_SEARCH',
  'ORGANIC_SOCIAL',
  'EMAIL',
  'AFFILIATE',
  'REFERRAL',
  'DIRECT',
  'OTHER',
  'UNKNOWN',
] as const;
export type AcquisitionChannel = (typeof ACQUISITION_CHANNELS)[number];
export type AcquisitionEvidence = {
  metaClickId?: string | null;
  tiktokClickId?: string | null;
  googleClickId?: string | null;
  googleBraidedClickId?: string | null;
  googleWebBraidedClickId?: string | null;
  metaAdExternalId?: string | null;
  metaAdSetExternalId?: string | null;
  metaCampaignExternalId?: string | null;
  utmSource?: string | null;
  utmMedium?: string | null;
  utmCampaign?: string | null;
  referrerUrl?: string | null;
  pageUrl?: string | null;
  landingPageUrl?: string | null;
};
const sourceAliases: Record<string, string> = {
  facebook: 'META',
  fb: 'META',
  meta: 'META',
  instagram: 'INSTAGRAM',
  ig: 'INSTAGRAM',
  tiktok: 'TIKTOK',
  tik_tok: 'TIKTOK',
  google: 'GOOGLE',
  bing: 'BING',
  youtube: 'YOUTUBE',
  pinterest: 'PINTEREST',
  klaviyo: 'KLAVIYO',
  mailchimp: 'MAILCHIMP',
};
function host(value?: string | null) {
  try {
    return value ? new URL(value).hostname.toLowerCase() : null;
  } catch {
    return null;
  }
}
function domain(h: string, d: string) {
  return h === d || h.endsWith(`.${d}`);
}
function referrerSource(h: string): { provider: string; channel: AcquisitionChannel } | null {
  if (/^(?:[a-z0-9-]+\.)*google\.(?:com|[a-z]{2}|co\.[a-z]{2}|com\.[a-z]{2})$/.test(h))
    return { provider: 'GOOGLE', channel: 'ORGANIC_SEARCH' };
  if (domain(h, 'bing.com')) return { provider: 'BING', channel: 'ORGANIC_SEARCH' };
  for (const [d, provider] of [
    ['instagram.com', 'INSTAGRAM'],
    ['facebook.com', 'META'],
    ['tiktok.com', 'TIKTOK'],
    ['youtube.com', 'YOUTUBE'],
    ['pinterest.com', 'PINTEREST'],
  ] as const) {
    if (domain(h, d)) return { provider, channel: 'ORGANIC_SOCIAL' };
  }
  return null;
}
export function classifyAcquisition(e: AcquisitionEvidence) {
  const source = e.utmSource?.trim().toLowerCase();
  const medium = e.utmMedium?.trim().toLowerCase();
  const provider = source ? (sourceAliases[source] ?? 'OTHER') : 'OTHER';
  const clicks = [
    Boolean(e.metaClickId),
    Boolean(e.tiktokClickId),
    Boolean(e.googleClickId || e.googleBraidedClickId || e.googleWebBraidedClickId),
  ].filter(Boolean).length;
  const result = (
    channel: AcquisitionChannel,
    provider: string | null,
    basis: string,
    paid: boolean | null,
  ) => ({
    channel,
    provider,
    basis,
    paid,
    version: ACQUISITION_VERSION,
    conflictingClickEvidence: clicks > 1,
  });
  if (e.metaClickId) return result('PAID_SOCIAL', 'META', 'META_CLICK', true);
  if (e.tiktokClickId) return result('PAID_SOCIAL', 'TIKTOK', 'TIKTOK_CLICK', true);
  // A Google click can originate from Search, Display, Shopping, YouTube or Performance Max.
  // Only explicit search medium evidence can narrow the channel; never guess from gclid alone.
  if (e.googleClickId || e.googleBraidedClickId || e.googleWebBraidedClickId)
    return result(
      ['paid_search', 'search', 'sem', 'ppc'].includes(medium ?? '') ? 'PAID_SEARCH' : 'OTHER',
      'GOOGLE',
      'GOOGLE_CLICK',
      true,
    );
  if (e.metaAdExternalId || e.metaAdSetExternalId || e.metaCampaignExternalId)
    return result('PAID_SOCIAL', 'META', 'META_LINK_ID', true);
  if (source || medium || e.utmCampaign) {
    if (['email', 'e-mail', 'newsletter'].includes(medium ?? ''))
      return result('EMAIL', provider, 'UTM', false);
    if (['affiliate', 'affiliates', 'partner'].includes(medium ?? ''))
      return result('AFFILIATE', provider, 'UTM', null);
    if (['paid_social', 'paidsocial', 'social_paid'].includes(medium ?? ''))
      return result('PAID_SOCIAL', provider, 'UTM', true);
    if (['paid_search', 'sem', 'ppc'].includes(medium ?? ''))
      return result('PAID_SEARCH', provider, 'UTM', true);
    if (medium === 'cpc')
      return result(
        ['GOOGLE', 'BING'].includes(provider)
          ? 'OTHER'
          : ['META', 'INSTAGRAM', 'TIKTOK', 'PINTEREST'].includes(provider)
            ? 'PAID_SOCIAL'
            : 'OTHER',
        provider,
        'UTM',
        true,
      );
    if (medium === 'organic')
      return result(
        ['GOOGLE', 'BING'].includes(provider) ? 'ORGANIC_SEARCH' : 'ORGANIC_SOCIAL',
        provider,
        'UTM',
        false,
      );
    if (['social', 'social-network', 'social_media'].includes(medium ?? ''))
      return result('ORGANIC_SOCIAL', provider, 'UTM', false);
    if (medium === 'referral') return result('REFERRAL', provider, 'UTM', null);
    return result('OTHER', provider, 'UTM', null);
  }
  const referring = host(e.referrerUrl);
  if (referring && referring !== host(e.pageUrl) && referring !== host(e.landingPageUrl)) {
    const known = referrerSource(referring);
    return known
      ? result(known.channel, known.provider, 'REFERRER', false)
      : result('REFERRAL', 'OTHER', 'REFERRER', null);
  }
  return e.pageUrl || e.landingPageUrl
    ? result('DIRECT', null, 'NO_EXTERNAL_EVIDENCE', null)
    : result('UNKNOWN', null, 'NO_EVIDENCE', null);
}
