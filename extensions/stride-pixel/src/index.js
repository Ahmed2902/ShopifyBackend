import {register} from '@shopify/web-pixels-extension';

const FLUSH_DELAY_MS = 750;
const MAX_BATCH_SIZE = 20;
const MAX_DELIVERY_ATTEMPTS = 3;
const SESSION_KEY = 'stride_pixel_session_id';
const LANDING_KEY = 'stride_pixel_landing';

const EVENT_NAMES = [
  'page_viewed',
  'product_viewed',
  'collection_viewed',
  'search_submitted',
  'product_added_to_cart',
  'product_removed_from_cart',
  'checkout_started',
  'checkout_contact_info_submitted',
  'checkout_address_info_submitted',
  'checkout_shipping_info_submitted',
  'payment_info_submitted',
  'checkout_completed',
];

const CHECKOUT_PROGRESS_EVENTS = new Set([
  'checkout_contact_info_submitted',
  'checkout_address_info_submitted',
  'checkout_shipping_info_submitted',
  'payment_info_submitted',
]);

const ATTRIBUTION_KEYS = [
  ['utm_source', 'utmSource'],
  ['utm_medium', 'utmMedium'],
  ['utm_campaign', 'utmCampaign'],
  ['utm_content', 'utmContent'],
  ['utm_term', 'utmTerm'],
  ['fbclid', 'metaClickId'],
  ['gclid', 'googleClickId'],
  ['ttclid', 'tiktokClickId'],
  ['stride_meta_campaign_id', 'metaCampaignExternalId'],
  ['stride_meta_adset_id', 'metaAdSetExternalId'],
  ['stride_meta_ad_id', 'metaAdExternalId'],
];

function safeUrl(value) {
  if (!value) return {url: undefined, attribution: {}};
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return {url: undefined, attribution: {}};
    }

    const attribution = {};
    for (const [queryKey, outputKey] of ATTRIBUTION_KEYS) {
      const queryValue = parsed.searchParams.get(queryKey)?.trim();
      if (queryValue) attribution[outputKey] = queryValue.slice(0, 512);
    }

    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return {url: parsed.toString(), attribution};
  } catch {
    return {url: undefined, attribution: {}};
  }
}

function hasAttribution(attribution) {
  return Boolean(attribution && Object.keys(attribution).length > 0);
}

function mapEventName(name) {
  if (name === 'page_viewed') return 'PAGE_VIEW';
  if (name === 'product_viewed') return 'PRODUCT_VIEW';
  if (name === 'collection_viewed') return 'COLLECTION_VIEW';
  if (name === 'search_submitted') return 'SEARCH';
  if (name === 'product_added_to_cart') return 'ADD_TO_CART';
  if (name === 'product_removed_from_cart') return 'REMOVE_FROM_CART';
  if (name === 'checkout_started') return 'BEGIN_CHECKOUT';
  if (name === 'checkout_completed') return 'CHECKOUT_COMPLETED';
  if (CHECKOUT_PROGRESS_EVENTS.has(name)) return 'CHECKOUT_PROGRESS';
  return null;
}

function merchandiseContext(event) {
  if (event.name === 'product_viewed') {
    const variant = event.data?.productVariant;
    return {
      productExternalId: variant?.product?.id ?? undefined,
      variantExternalId: variant?.id ?? undefined,
    };
  }

  if (event.name === 'collection_viewed') {
    return {
      collectionExternalId: event.data?.collection?.id ?? undefined,
    };
  }

  if (event.name === 'product_added_to_cart' || event.name === 'product_removed_from_cart') {
    const line = event.data?.cartLine;
    return {
      productExternalId: line?.merchandise?.product?.id ?? undefined,
      variantExternalId: line?.merchandise?.id ?? undefined,
      quantity: line?.quantity ?? undefined,
    };
  }

  return {};
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

register(async ({analytics, browser, customerPrivacy, init, settings}) => {
  const collectorUrl = typeof settings.collectorUrl === 'string' ? settings.collectorUrl : '';
  const installationId =
    typeof settings.installationId === 'string' ? settings.installationId : '';
  const collectorToken =
    typeof settings.collectorToken === 'string' ? settings.collectorToken : '';

  if (!collectorUrl || !installationId || !collectorToken) return;

  let privacy = init.customerPrivacy;
  let sessionId = await browser.sessionStorage.get(SESSION_KEY);
  let landing = null;
  const storedLanding = await browser.sessionStorage.get(LANDING_KEY);
  if (storedLanding) {
    try {
      landing = JSON.parse(storedLanding);
    } catch {
      landing = null;
    }
  }

  const queue = [];
  let flushTimer = null;
  let flushing = false;

  customerPrivacy.subscribe('visitorConsentCollected', (event) => {
    privacy = event.customerPrivacy;
  });

  async function deliver(events) {
    const body = JSON.stringify({installationId, collectorToken, events});

    for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      try {
        const response = await fetch(collectorUrl, {
          method: 'POST',
          body,
          keepalive: true,
        });
        if (response.ok) return;
        if (response.status < 500 && response.status !== 429) return;
      } catch {
        // Retry bounded transient failures only. Durable dedupe is eventId-based server-side.
      }

      if (attempt < MAX_DELIVERY_ATTEMPTS - 1) {
        await delay(250 * 2 ** attempt);
      }
    }
  }

  async function flush() {
    if (flushing || queue.length === 0) return;
    flushing = true;
    if (flushTimer) {
      clearTimeout(flushTimer);
      flushTimer = null;
    }

    try {
      while (queue.length > 0) {
        const batch = queue.splice(0, MAX_BATCH_SIZE);
        await deliver(batch);
      }
    } finally {
      flushing = false;
    }
  }

  function scheduleFlush() {
    if (queue.length >= MAX_BATCH_SIZE) {
      void flush();
      return;
    }
    if (flushTimer) return;
    flushTimer = setTimeout(() => void flush(), FLUSH_DELAY_MS);
  }

  async function handle(event) {
    if (!privacy?.analyticsProcessingAllowed) return;

    const eventName = mapEventName(event.name);
    if (!eventName) return;

    if (!sessionId) {
      sessionId = event.id;
      await browser.sessionStorage.set(SESSION_KEY, sessionId);
    }

    const current = safeUrl(event.context?.document?.location?.href);
    if (!landing || hasAttribution(current.attribution)) {
      landing = current;
      await browser.sessionStorage.set(LANDING_KEY, JSON.stringify(landing));
    }
    const referrer = safeUrl(event.context?.document?.referrer);

    queue.push({
      eventId: event.id,
      eventVersion: 1,
      eventName,
      eventAt: event.timestamp,
      anonymousVisitorId: event.clientId || undefined,
      sessionId: sessionId || undefined,
      consentState: 'GRANTED',
      pageUrl: current.url,
      referrerUrl: referrer.url,
      landingPageUrl: landing?.url,
      ...merchandiseContext(event),
      attribution: landing?.attribution,
    });
    scheduleFlush();
  }

  for (const eventName of EVENT_NAMES) {
    analytics.subscribe(eventName, (event) => {
      void handle(event);
    });
  }
});
