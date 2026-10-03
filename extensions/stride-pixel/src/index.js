import { register } from '@shopify/web-pixels-extension';

const FLUSH_DELAY_MS = 750;
const MAX_BATCH_SIZE = 20;
const MAX_DELIVERY_ATTEMPTS = 3;
const SESSION_INACTIVITY_MS = 30 * 60 * 1000;
const SESSION_KEY = 'stride_pixel_session_id';
const SESSION_LAST_ACTIVITY_KEY = 'stride_pixel_session_last_activity_at';
const LANDING_KEY = 'stride_pixel_landing';
const WITHDRAWAL_KEY = 'stride_pixel_withdrawal_';
const PRIVACY_VISITOR_KEY = 'stride_pixel_privacy_visitor_id';
const PRIVACY_SESSION_KEY = 'stride_pixel_privacy_session_id';

const EVENT_NAMES = [
  'page_viewed',
  'product_viewed',
  'collection_viewed',
  'search_submitted',
  'product_added_to_cart',
  'product_removed_from_cart',
  'cart_viewed',
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
  ['gbraid', 'googleBraidedClickId'],
  ['wbraid', 'googleWebBraidedClickId'],
  ['ttclid', 'tiktokClickId'],
  ['stride_meta_campaign_id', 'metaCampaignExternalId'],
  ['stride_meta_adset_id', 'metaAdSetExternalId'],
  ['stride_meta_ad_id', 'metaAdExternalId'],
];

function shopifyGid(type, value) {
  if (value === null || value === undefined) return undefined;
  const raw = String(value).trim();
  if (!raw) return undefined;
  if (raw.startsWith(`gid://shopify/${type}/`)) return raw;
  if (/^\d+$/.test(raw)) return `gid://shopify/${type}/${raw}`;
  return raw;
}

function safeUrl(value) {
  if (!value) return { url: undefined, attribution: {} };
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return { url: undefined, attribution: {} };
    }

    const attribution = {};
    for (const [queryKey, outputKey] of ATTRIBUTION_KEYS) {
      const queryValue = parsed.searchParams.get(queryKey)?.trim();
      if (
        !queryValue ||
        queryValue.includes('@') ||
        /https?:\/\//i.test(queryValue) ||
        [...queryValue].some((c) => c.charCodeAt(0) < 32)
      )
        continue;
      if (outputKey.endsWith('ClickId') && !/^[A-Za-z0-9._~-]+$/.test(queryValue)) continue;

      if (outputKey.endsWith('ExternalId')) {
        if (queryValue.length <= 128 && /^\d+$/.test(queryValue)) {
          attribution[outputKey] = queryValue;
        }
        continue;
      }

      const maxLength = outputKey.endsWith('ClickId') ? 512 : 255;
      attribution[outputKey] = queryValue.slice(0, maxLength);
    }

    parsed.username = '';
    parsed.password = '';
    if (/^\/(?:checkouts?|account)(?:\/|$)/i.test(parsed.pathname))
      parsed.pathname = '/' + parsed.pathname.split('/')[1];
    parsed.search = '';
    parsed.hash = '';
    return { url: parsed.toString(), attribution };
  } catch {
    return { url: undefined, attribution: {} };
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
  if (name === 'cart_viewed') return 'CART_VIEW';
  if (name === 'checkout_started') return 'BEGIN_CHECKOUT';
  if (name === 'checkout_completed') return 'CHECKOUT_COMPLETED';
  if (CHECKOUT_PROGRESS_EVENTS.has(name)) return 'CHECKOUT_PROGRESS';
  return null;
}

function merchandiseContext(event) {
  if (event.name === 'product_viewed') {
    const variant = event.data?.productVariant;
    return {
      productExternalId: shopifyGid('Product', variant?.product?.id),
      variantExternalId: shopifyGid('ProductVariant', variant?.id),
    };
  }

  if (event.name === 'collection_viewed') {
    return {
      collectionExternalId: shopifyGid('Collection', event.data?.collection?.id),
    };
  }

  if (event.name === 'product_added_to_cart' || event.name === 'product_removed_from_cart') {
    const line = event.data?.cartLine;
    return {
      productExternalId: shopifyGid('Product', line?.merchandise?.product?.id),
      variantExternalId: shopifyGid('ProductVariant', line?.merchandise?.id),
      quantity: line?.quantity ?? undefined,
    };
  }

  return {};
}

function checkoutContext(event) {
  if (
    event.name !== 'checkout_started' &&
    event.name !== 'checkout_completed' &&
    !CHECKOUT_PROGRESS_EVENTS.has(event.name)
  ) {
    return {};
  }

  const checkout = event.data?.checkout;
  const token = typeof checkout?.token === 'string' ? checkout.token.trim().slice(0, 255) : '';
  const orderId =
    event.name === 'checkout_completed' ? shopifyGid('Order', checkout?.order?.id) : undefined;

  return {
    shopifyCheckoutToken: token || undefined,
    shopifyOrderExternalId: orderId,
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

register(async ({ analytics, browser, customerPrivacy, init, settings }) => {
  const collectorUrl = typeof settings.collectorUrl === 'string' ? settings.collectorUrl : '';
  const installationId = typeof settings.installationId === 'string' ? settings.installationId : '';
  const collectorToken = typeof settings.collectorToken === 'string' ? settings.collectorToken : '';

  if (!collectorUrl || !installationId || !collectorToken) return;

  let privacy = init.customerPrivacy;
  let privacyRevision = 0;
  let sessionId = await browser.sessionStorage.getItem(SESSION_KEY);
  let lastActivityAtMs = 0;
  const storedLastActivity = await browser.sessionStorage.getItem(SESSION_LAST_ACTIVITY_KEY);
  if (storedLastActivity) {
    const parsedLastActivity = Number(storedLastActivity);
    if (Number.isFinite(parsedLastActivity) && parsedLastActivity > 0) {
      lastActivityAtMs = parsedLastActivity;
    }
  }

  let landing = null;
  const storedLanding = await browser.sessionStorage.getItem(LANDING_KEY);
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
  let inFlightBatch = null;
  let lastVisitorId = await browser.sessionStorage.getItem(PRIVACY_VISITOR_KEY);
  let lastSessionId = (await browser.sessionStorage.getItem(PRIVACY_SESSION_KEY)) || sessionId;
  let handling = Promise.resolve();

  let withdrawalSending = false;
  const withdrawalStorageKey = WITHDRAWAL_KEY + installationId;
  let pendingWithdrawals = [];
  let withdrawalStorageWrites = Promise.resolve();
  try {
    const stored = JSON.parse((await browser.localStorage.getItem(withdrawalStorageKey)) || 'null');
    pendingWithdrawals = Array.isArray(stored) ? stored : stored ? [stored] : [];
  } catch {
    /* No retained marker. */
  }
  function persistWithdrawals() {
    withdrawalStorageWrites = withdrawalStorageWrites
      .catch(() => undefined)
      .then(async () => {
        if (pendingWithdrawals.length)
          await browser.localStorage.setItem(
            withdrawalStorageKey,
            JSON.stringify(pendingWithdrawals),
          );
        else await browser.localStorage.removeItem(withdrawalStorageKey);
      });
    return withdrawalStorageWrites.catch(() => undefined);
  }
  async function deliverWithdrawal(withdrawal) {
    // Keep every unacknowledged scope. A new scope must never overwrite an in-flight marker.
    if (!pendingWithdrawals.some((marker) => JSON.stringify(marker) === JSON.stringify(withdrawal)))
      pendingWithdrawals.push(withdrawal);
    await persistWithdrawals();
    await retryWithdrawal();
  }
  async function retryWithdrawal() {
    if (withdrawalSending || !pendingWithdrawals.length) return;
    withdrawalSending = true;
    const marker = pendingWithdrawals[0];
    try {
      const response = await fetch(collectorUrl, {
        method: 'POST',
        body: JSON.stringify({ installationId, collectorToken, events: [], withdrawal: marker }),
        keepalive: true,
      });
      if (response.ok) {
        pendingWithdrawals = pendingWithdrawals.filter((item) => item !== marker);
        await persistWithdrawals();
      }
    } catch {
      /* Keep the privacy marker until collector acknowledgment, including across reloads. */
    } finally {
      withdrawalSending = false;
      if (pendingWithdrawals.length)
        setTimeout(() => {
          void retryWithdrawal();
        }, 5000);
    }
  }
  if (pendingWithdrawals.length) void retryWithdrawal();
  if (!adSharingAllowed()) {
    landing = null;
    await browser.sessionStorage.removeItem(LANDING_KEY);
  }

  customerPrivacy.subscribe('visitorConsentCollected', (event) => {
    privacyRevision += 1;
    privacy = event.customerPrivacy;
    // Re-check queued events when consent changes before transmitting them.
    for (const batch of [queue, inFlightBatch ?? []]) {
      for (const queued of batch) {
        queued.adSharingAllowed = queued.adSharingAllowed && adSharingAllowed();
        if (!queued.adSharingAllowed) delete queued.browserMatch;
      }
      if (!privacy?.analyticsProcessingAllowed) batch.length = 0;
    }
    if (!adSharingAllowed()) {
      landing = null;
      void browser.sessionStorage.removeItem(LANDING_KEY).catch(() => undefined);
    }
    if (!adSharingAllowed() && (lastVisitorId || lastSessionId)) {
      // A privacy operation, not an analytics event. It must reach the collector even when
      // no subsequent storefront event occurs or analytics permission has been withdrawn.
      void deliverWithdrawal({
        ...(lastVisitorId ? { anonymousVisitorId: lastVisitorId } : {}),
        ...(lastSessionId ? { sessionId: lastSessionId } : {}),
      });
    }
  });

  function adSharingAllowed() {
    return (
      privacy?.analyticsProcessingAllowed === true &&
      privacy?.marketingAllowed === true &&
      privacy?.saleOfDataAllowed === true
    );
  }

  async function deliver(events) {
    for (let attempt = 0; attempt < MAX_DELIVERY_ATTEMPTS; attempt += 1) {
      if (!privacy?.analyticsProcessingAllowed || events.length === 0) return;
      // A retry must use current permission, and withdrawal is sticky for this batch.
      for (const event of events) {
        event.adSharingAllowed = event.adSharingAllowed && adSharingAllowed();
        if (!event.adSharingAllowed) delete event.browserMatch;
      }
      const body = JSON.stringify({ installationId, collectorToken, events });
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
        inFlightBatch = batch;
        try {
          await deliver(batch);
        } finally {
          inFlightBatch = null;
        }
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
    flushTimer = setTimeout(() => {
      flushTimer = null;
      void flush();
    }, FLUSH_DELAY_MS);
  }

  async function startNewSession(eventId) {
    sessionId = eventId;
    landing = null;
    lastActivityAtMs = 0;
    await Promise.all([
      browser.sessionStorage.setItem(SESSION_KEY, sessionId),
      browser.sessionStorage.setItem(LANDING_KEY, ''),
      browser.sessionStorage.setItem(SESSION_LAST_ACTIVITY_KEY, ''),
    ]);
  }

  async function clearSessionBoundary() {
    sessionId = null;
    landing = null;
    lastActivityAtMs = 0;
    await Promise.all([
      browser.sessionStorage.removeItem(SESSION_KEY),
      browser.sessionStorage.removeItem(LANDING_KEY),
      browser.sessionStorage.removeItem(SESSION_LAST_ACTIVITY_KEY),
    ]);
  }

  async function ensureSession(event) {
    const parsedEventAt = Date.parse(event.timestamp);
    const eventAtMs = Number.isFinite(parsedEventAt) ? parsedEventAt : Date.now();
    const inactivityBoundary =
      Boolean(sessionId) &&
      lastActivityAtMs > 0 &&
      eventAtMs >= lastActivityAtMs &&
      eventAtMs - lastActivityAtMs >= SESSION_INACTIVITY_MS;

    if (!sessionId || inactivityBoundary) {
      await startNewSession(event.id);
    }

    lastActivityAtMs = Math.max(lastActivityAtMs, eventAtMs);
    await browser.sessionStorage.setItem(SESSION_LAST_ACTIVITY_KEY, String(lastActivityAtMs));
  }

  async function handle(event) {
    if (!privacy?.analyticsProcessingAllowed) return;
    const revision = privacyRevision;
    if (pendingWithdrawals.length) {
      await retryWithdrawal();
      if (pendingWithdrawals.length) return;
    }

    const eventName = mapEventName(event.name);
    if (!eventName) return;

    await ensureSession(event);
    if (revision !== privacyRevision || !privacy?.analyticsProcessingAllowed) return;
    lastVisitorId = event.clientId || lastVisitorId;
    lastSessionId = sessionId;
    await Promise.all([
      ...(lastVisitorId
        ? [browser.sessionStorage.setItem(PRIVACY_VISITOR_KEY, lastVisitorId)]
        : []),
      browser.sessionStorage.setItem(PRIVACY_SESSION_KEY, lastSessionId),
    ]);
    if (revision !== privacyRevision || !privacy?.analyticsProcessingAllowed) return;

    const current = safeUrl(event.context?.document?.location?.href);
    if (!landing || hasAttribution(current.attribution)) {
      landing = current;
      await browser.sessionStorage.setItem(LANDING_KEY, JSON.stringify(landing));
    }
    const referrer = safeUrl(event.context?.document?.referrer);
    if (revision !== privacyRevision || !privacy?.analyticsProcessingAllowed) return;

    let browserMatch;
    if (adSharingAllowed()) {
      const readCookie = async (key) => {
        try {
          return await browser.cookie.get(key);
        } catch {
          return undefined;
        }
      };
      const [fbp, ttp] = await Promise.all([readCookie('_fbp'), readCookie('_ttp')]);
      const userAgent = event.context?.navigator?.userAgent;
      browserMatch = {
        ...(typeof fbp === 'string' && /^fb\.[0-2]\.\d{13}\.\d+$/.test(fbp) ? { fbp } : {}),
        ...(typeof ttp === 'string' && /^[A-Za-z0-9_.-]{1,512}$/.test(ttp) ? { ttp } : {}),
        ...(typeof userAgent === 'string' &&
        userAgent.length <= 1024 &&
        ![...userAgent].some((char) => char.charCodeAt(0) < 32)
          ? { userAgent }
          : {}),
      };
    }
    if (revision !== privacyRevision || !privacy?.analyticsProcessingAllowed) return;
    queue.push({
      eventId: event.id,
      eventVersion: 1,
      eventName,
      eventAt: event.timestamp,
      anonymousVisitorId: event.clientId || undefined,
      sessionId: sessionId || undefined,
      consentState: 'GRANTED',
      adSharingAllowed: adSharingAllowed(),
      ...(adSharingAllowed() && browserMatch ? { browserMatch } : {}),
      pageUrl: current.url,
      referrerUrl: referrer.url,
      landingPageUrl: landing?.url,
      ...merchandiseContext(event),
      ...checkoutContext(event),
      attribution: landing?.attribution,
    });
    scheduleFlush();

    if (eventName === 'CHECKOUT_COMPLETED') {
      await clearSessionBoundary();
    }
  }

  for (const eventName of EVENT_NAMES) {
    analytics.subscribe(eventName, (event) => {
      handling = handling.then(() => handle(event)).catch(() => undefined);
    });
  }
});
