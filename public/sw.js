const VERSION = 'ironlog-v143';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/api.js',
  '/bugreport.js',
  '/utils.js',
  '/audio.js',
  '/workout.js',
  '/programs.js',
  '/progress.js',
  '/history.js',
  '/settings.js',
  '/chart.umd.min.js',
  '/manifest.json',
  '/icon.svg',
  '/fonts/saira-condensed-700.woff2',
  '/fonts/saira-condensed-800.woff2',
  '/fonts/hanken-grotesk-400.woff2',
  '/fonts/hanken-grotesk-600.woff2',
  '/fonts/jetbrains-mono-500.woff2',
  '/fonts/jetbrains-mono-700.woff2'
];

self.addEventListener('install', (event) => {
  // Precache the new shell but DON'T skipWaiting here — the new worker waits
  // until the page tells it to (via the "Update available" prompt), or until
  // the next cold launch. This avoids swapping assets out from under a running
  // page. The page posts {type:'skip-waiting'} when the user taps Refresh.
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(SHELL)));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // API calls: network-first, no caching
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
    event.respondWith(fetch(req).catch(() => new Response('{"error":"offline"}', {
      status: 503,
      headers: { 'Content-Type': 'application/json' }
    })));
    return;
  }

  // Immutable vendor/static assets: cache-first (instant, no per-launch
  // network cost — the chart lib alone is ~200 KB). These only change on a
  // VERSION bump, and install's cache.addAll() refreshes them then, so
  // cache-first within the versioned cache never serves them stale.
  if (CACHE_FIRST.has(url.pathname) || url.pathname.startsWith('/fonts/')) {
    event.respondWith(cacheFirst(req, url));
    return;
  }

  // App shell code: NETWORK-FIRST with a short timeout, falling back to cache.
  // Cache-first used to leave installed phones running stale code for days
  // (iOS keeps the PWA warm, so background refresh rarely ran). Network-first
  // means an online launch always gets the latest code; offline or slow
  // launches fall back to the cached copy so the app still opens instantly.
  event.respondWith(networkFirst(req, url));
});

const SHELL_TIMEOUT_MS = 2500;
const CACHE_FIRST = new Set(['/chart.umd.min.js', '/icon.svg', '/manifest.json']);

async function cacheFirst(req, url) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const res = await fetch(req);
    if (res && res.ok && url.origin === self.location.origin) cache.put(req, res.clone());
    return res;
  } catch {
    return Response.error();
  }
}

async function networkFirst(req, url) {
  const cache = await caches.open(VERSION);
  const cached = await cache.match(req);

  const fromNetwork = fetch(req)
    .then((res) => {
      if (res && res.ok && url.origin === self.location.origin) cache.put(req, res.clone());
      return res;
    });

  // No cached copy yet: we have to wait for the network (or fail to the shell).
  if (!cached) {
    try { return await fromNetwork; }
    catch { return (await cache.match('/index.html')) || Response.error(); }
  }

  // Have a cached copy: prefer fresh, but don't let a slow network stall the
  // launch. Serve cache if the network is slow (timeout -> null), errors, OR
  // returns a non-ok status (e.g. a 500 mid-deploy) — a bad deploy must never
  // replace working cached code with an error page.
  try {
    const fresh = await Promise.race([
      fromNetwork,
      new Promise((resolve) => setTimeout(() => resolve(null), SHELL_TIMEOUT_MS))
    ]);
    return fresh && fresh.ok ? fresh : cached;
  } catch {
    return cached;
  }
}

// Allow page to ask SW to show a notification (used for local rest-timer alerts).
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'skip-waiting') {
    // User tapped "Refresh" on the update prompt — activate now and take over.
    self.skipWaiting();
    return;
  }
  if (data.type === 'show-notification') {
    const title = data.title || 'IronLog';
    const options = {
      body: data.body || '',
      tag: data.tag || 'ironlog',
      icon: '/icon.svg',
      badge: '/icon.svg',
      vibrate: data.vibrate || [200, 100, 200, 100, 400],
      requireInteraction: data.requireInteraction ?? true,
      renotify: true
    };
    event.waitUntil(self.registration.showNotification(title, options));
  }
});

// Server-pushed notifications
self.addEventListener('push', (event) => {
  let payload = { title: 'IronLog', body: '' };
  if (event.data) {
    try {
      payload = event.data.json();
    } catch {
      payload = { title: 'IronLog', body: event.data.text() };
    }
  }
  const title = payload.title || 'IronLog';
  const options = {
    body: payload.body || '',
    tag: payload.tag || 'ironlog',
    icon: '/icon.svg',
    badge: '/icon.svg',
    vibrate: payload.vibrate || [200, 100, 200, 100, 400],
    renotify: true,
    data: payload.data || {}
  };
  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
      const existing = wins.find((w) => w.url.includes(self.location.origin));
      if (existing) return existing.focus();
      return self.clients.openWindow('/');
    })
  );
});
