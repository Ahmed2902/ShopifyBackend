/* global window, document */
(() => {
  'use strict';
  if (window.__strideBrowserSignals) return;
  window.__strideBrowserSignals = true;
  const PREFIX = 'stride_browser_batch_v1_';
  const HEARTBEAT = 'stride_browser_heartbeat_v1';
  let revision = 0;
  let active = true;
  let revokedOnPage = false;
  let busy = false;
  let sdk;
  const initialized = new Set();
  const submitted = new Set();
  function permissionsGranted() {
    const p = window.Shopify?.customerPrivacy;
    return (
      p?.analyticsProcessingAllowed() === true &&
      p?.marketingAllowed() === true &&
      p?.saleOfDataAllowed() === true
    );
  }
  function permitted() {
    return active && !revokedOnPage && permissionsGranted();
  }
  // The SDK transmits page/referrer context. Fail closed on private surfaces and unreviewed
  // parameters; canonical collector URLs do not make the real browser location sanitized.
  function safeContext(value) {
    if (!value) return true;
    try {
      const url = new URL(value);
      const path = decodeURIComponent(url.pathname);
      if (
        url.protocol !== 'https:' ||
        url.username ||
        url.password ||
        /\/(?:checkouts?|account|orders|apps|challenge)(?:\/|$)|\/cart\/c(?:\/|$)/i.test(path) ||
        url.hash ||
        /@/i.test(path)
      )
        return false;
      const allowed =
        /^(?:utm_(?:source|medium|campaign|content|term)|fbclid|gclid|gbraid|wbraid|ttclid|stride_meta_(?:campaign|adset|ad)_id)$/;
      for (const [name, value] of url.searchParams) {
        if (name === 'variant' && /^\d+$/.test(value)) continue;
        if (
          !allowed.test(name) ||
          value.length > 512 ||
          /@|%40/i.test(value) ||
          [...value].some((c) => c.charCodeAt(0) < 32)
        )
          return false;
      }
      return true;
    } catch {
      return false;
    }
  }
  function clearBridge() {
    try {
      sessionStorage.removeItem(HEARTBEAT);
      const keys = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key?.startsWith(PREFIX)) keys.push(key);
      }
      keys.forEach((key) => sessionStorage.removeItem(key));
    } catch {
      /* Browser storage may be unavailable. */
    }
  }
  function consentChanged() {
    revision++;
    clearBridge();
    if (!permissionsGranted()) {
      revokedOnPage = true;
      if (window.__strideOwnsMetaSdk) {
        window.fbq('consent', 'revoke');
        for (const name of ['_fbp', '_fbc']) {
          document.cookie = name + '=; Max-Age=0; Path=/; Secure; SameSite=Lax';
          const parts = window.location.hostname.split('.');
          for (let i = 0; i < parts.length - 1; i++)
            document.cookie =
              name +
              '=; Max-Age=0; Path=/; Domain=.' +
              parts.slice(i).join('.') +
              '; Secure; SameSite=Lax';
        }
      }
    }
  }
  document.addEventListener('visitorConsentCollected', consentChanged);
  window.addEventListener('pagehide', () => {
    active = false;
    revision++;
    clearBridge();
    if (window.__strideOwnsMetaSdk) window.fbq('consent', 'revoke');
  });
  window.addEventListener('pageshow', () => {
    if (!active) {
      active = true;
      void tick();
    }
  });
  function loadSdk() {
    if (sdk) return sdk;
    if (window.fbq) return Promise.reject(new Error('EXISTING_META_BROWSER_TRACKER'));
    sdk = new Promise((resolve, reject) => {
      const fbq = function () {
        if (fbq.callMethod) fbq.callMethod.apply(fbq, arguments);
        else fbq.queue.push(arguments);
      };
      fbq.queue = [];
      fbq.loaded = true;
      fbq.version = '2.0';
      fbq.push = fbq;
      window.fbq = fbq;
      window._fbq = fbq;
      window.__strideOwnsMetaSdk = true;
      fbq('consent', 'revoke');
      const script = document.createElement('script');
      script.async = true;
      script.src = 'https://connect.facebook.net/en_US/fbevents.js';
      script.onload = () => resolve();
      script.onerror = () => reject(new Error('META_SDK_UNAVAILABLE'));
      setTimeout(() => reject(new Error('META_SDK_TIMEOUT')), 5000);
      document.head.appendChild(script);
    });
    return sdk;
  }
  function browserId() {
    if (!permitted() || !safeContext(window.location.href) || !safeContext(document.referrer))
      return undefined;
    const cookie = document.cookie
      .split(';')
      .map((v) => v.trim())
      .find((v) => v.startsWith('_fbp='));
    const value = cookie?.slice(5);
    return /^fb\.[0-2]\.\d{13}\.\d+$/.test(value || '') ? value : undefined;
  }
  function validDispatch(d) {
    if (
      !d ||
      !/^\d{1,64}$/.test(d.pixelId) ||
      !/^stride:event:[a-f0-9]{64}$/.test(d.eventId) ||
      !['PageView', 'ViewContent', 'AddToCart'].includes(d.eventName)
    )
      return false;
    const c = d.customData;
    if (
      !c ||
      typeof c !== 'object' ||
      Object.keys(c).some(
        (k) =>
          !['currency', 'value', 'content_type', 'content_ids', 'contents', 'num_items'].includes(
            k,
          ),
      )
    )
      return false;
    if (c.currency !== undefined && !/^[A-Z]{3}$/.test(c.currency)) return false;
    if (
      c.value !== undefined &&
      (typeof c.value !== 'number' || !Number.isFinite(c.value) || c.value < 0)
    )
      return false;
    if (c.content_type !== undefined && c.content_type !== 'product') return false;
    if (c.num_items !== undefined && (!Number.isInteger(c.num_items) || c.num_items < 1))
      return false;
    const safeId = (id) =>
      typeof id === 'string' &&
      id.length > 0 &&
      id.length <= 256 &&
      !id.includes('@') &&
      ![...id].some((v) => v.charCodeAt(0) < 32);
    if (
      c.content_ids !== undefined &&
      (!Array.isArray(c.content_ids) || c.content_ids.length > 100 || !c.content_ids.every(safeId))
    )
      return false;
    if (
      c.contents !== undefined &&
      (!Array.isArray(c.contents) ||
        c.contents.length > 100 ||
        !c.contents.every(
          (i) =>
            i &&
            safeId(i.id) &&
            Object.keys(i).every((k) => ['id', 'quantity', 'item_price'].includes(k)) &&
            (i.quantity === undefined || (Number.isInteger(i.quantity) && i.quantity > 0)) &&
            (i.item_price === undefined ||
              (typeof i.item_price === 'number' &&
                Number.isFinite(i.item_price) &&
                i.item_price >= 0)),
        ))
    )
      return false;
    return true;
  }
  async function authorize(batch, reported, browserFailureCode) {
    const endpoint = new URL(batch.collectorUrl);
    if (
      endpoint.protocol !== 'https:' ||
      endpoint.pathname !== '/v1/pixel/events' ||
      endpoint.search ||
      endpoint.hash ||
      endpoint.username ||
      endpoint.password
    )
      throw new Error('COLLECTOR_ENDPOINT_INVALID');
    endpoint.pathname += '/browser';
    const response = await fetch(endpoint, {
      method: 'POST',
      credentials: 'omit',
      headers: { 'Content-Type': 'text/plain' },
      signal: AbortSignal.timeout(5000),
      body: JSON.stringify({
        installationId: batch.installationId,
        collectorToken: batch.collectorToken,
        eventIds: reported ? [reported.clientEventId] : batch.eventIds,
        ...(browserId() ? { fbp: browserId() } : {}),
        ...(reported ? { dispatchedDestinationIds: [reported.destinationId] } : {}),
        ...(browserFailureCode ? { browserFailureCode } : {}),
      }),
    });
    if (!response.ok) throw new Error('BROWSER_AUTHORIZATION_UNAVAILABLE');
    return response.json();
  }
  async function tick() {
    try {
      if (!permitted()) {
        clearBridge();
        return;
      }
      sessionStorage.setItem(HEARTBEAT, String(Date.now() + 3000));
      if (busy) return;
      busy = true;
      const keys = [];
      for (let i = 0; i < sessionStorage.length; i++) {
        const key = sessionStorage.key(i);
        if (key?.startsWith(PREFIX)) keys.push(key);
      }
      for (const key of keys.slice(0, 20)) {
        const raw = sessionStorage.getItem(key);
        sessionStorage.removeItem(key);
        let batch;
        try {
          batch = JSON.parse(raw || 'null');
        } catch {
          continue;
        }
        if (
          !batch ||
          batch.expiresAt < Date.now() ||
          !Array.isArray(batch.eventIds) ||
          batch.eventIds.length > 20
        )
          continue;
        const epoch = revision;
        if (!safeContext(window.location.href) || !safeContext(document.referrer)) {
          await authorize(batch, undefined, 'BROWSER_CONTEXT_BLOCKED');
          continue;
        }
        let receipt = await authorize(batch);
        if (!receipt.dispatches?.length || !permitted() || epoch !== revision) continue;
        try {
          await loadSdk();
        } catch (error) {
          if (
            permitted() &&
            epoch === revision &&
            ['EXISTING_META_BROWSER_TRACKER', 'META_SDK_UNAVAILABLE', 'META_SDK_TIMEOUT'].includes(
              error.message,
            )
          )
            await authorize(batch, undefined, error.message);
          continue;
        }
        if (!permitted() || epoch !== revision) continue;
        // SDK loading is asynchronous. Reauthorize after it, before any init or track call.
        receipt = await authorize(batch);
        if (!permitted() || epoch !== revision || Date.parse(receipt.expiresAt) <= Date.now())
          continue;
        for (const dispatch of receipt.dispatches) {
          if (!validDispatch(dispatch)) continue;
          const unique = dispatch.destinationId + ':' + dispatch.eventId;
          if (
            submitted.has(unique) ||
            !permitted() ||
            epoch !== revision ||
            Date.parse(receipt.expiresAt) <= Date.now()
          )
            continue;
          window.fbq('consent', 'grant');
          if (!initialized.has(dispatch.pixelId)) {
            window.fbq('set', 'autoConfig', false, dispatch.pixelId);
            window.fbq('init', dispatch.pixelId);
            initialized.add(dispatch.pixelId);
          }
          window.fbq('trackSingle', dispatch.pixelId, dispatch.eventName, dispatch.customData, {
            eventID: dispatch.eventId,
          });
          submitted.add(unique);
          if (submitted.size > 500) submitted.delete(submitted.values().next().value);
          if (permitted() && epoch === revision) await authorize(batch, dispatch);
        }
      }
    } catch {
      /* Ad blockers, overlap and network failures leave server delivery independent. */
    } finally {
      busy = false;
      if (active) setTimeout(() => void tick(), 500);
    }
  }
  if (window.Shopify?.loadFeatures)
    window.Shopify.loadFeatures([{ name: 'consent-tracking-api', version: '0.1' }], (error) => {
      if (!error) void tick();
    });
})();
