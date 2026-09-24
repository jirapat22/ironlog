const VERSION = 'ironlog-v249';
// Last-known API responses, kept OUT of the versioned shell cache on purpose:
// wiping it on every deploy would mean the first launch after an update has
// nothing to fall back on, which is exactly when you are least likely to have
// signal to spare. Survives activate (see the filter below).
const API_CACHE = 'ironlog-api';
// One entry per distinct URL, and History alone can visit a per-workout
// endpoint for every session you have ever logged. Generous enough that a
// normal launch's worth of requests never evicts each other, bounded so the
// cache cannot grow for the life of the install.
const API_CACHE_MAX = 120;
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

function offlineResponse() {
  return new Response('{"error":"offline"}', {
    status: 503,
    headers: { 'Content-Type': 'application/json' }
  });
}

// Network first, so a reachable server always wins and nothing is ever served
// stale while online. Only a failed request falls back, and what comes back is
// tagged so the page can say it is showing last-known data rather than
// pretending it is current.
// cache.keys() resolves in insertion order, so the front of the list is the
// least recently STORED. Fire-and-forget: a failed trim must never delay or
// fail the response it rode in on.
function trimApiCache(cache) {
  cache.keys().then((keys) => {
    if (keys.length <= API_CACHE_MAX) return;
    return Promise.all(keys.slice(0, keys.length - API_CACHE_MAX).map((k) => cache.delete(k)));
  }).catch(() => {});
}

async function apiNetworkFirst(req) {
  const cache = await caches.open(API_CACHE);
  try {
    const res = await fetch(req);
    // Only success is worth remembering. Caching a 4xx/5xx would pin an error
    // as this endpoint's "last known good" until it next succeeds.
    if (res && res.ok) {
      await cache.put(req, res.clone()).catch(() => {});
      trimApiCache(cache);
    }
    return res;
  } catch {
    const hit = await cache.match(req);
    if (!hit) return offlineResponse();
    const body = await hit.text();
    return new Response(body, {
      status: 200,
      headers: { 'Content-Type': 'application/json', 'X-Ironlog-Cached': '1' }
    });
  }
}

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
        Promise.all(keys.filter((k) => k !== VERSION && k !== API_CACHE).map((k) => caches.delete(k)))
      )
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;

  const url = new URL(req.url);

  // API calls: network-first, falling back to the last good response.
  //
  // This used to be network-only, which meant a launch with no connection
  // showed an error in every view — the app was not readable offline at all,
  // despite comments here and elsewhere claiming it was. A phone in a gym
  // basement is the normal case for this app, so the last thing it saw is a
  // far better answer than an error panel.
  if (url.pathname.startsWith('/api/') || url.pathname === '/health') {
    // Auth is the exception. A cached "you are signed in" would be a claim
    // about a session this worker cannot vouch for; app.js has its own
    // deliberate offline path for that, built on a profile IT cached.
    if (url.pathname.startsWith('/api/auth/')) {
      event.respondWith(fetch(req).catch(offlineResponse));
      return;
    }
    event.respondWith(apiNetworkFirst(req));
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
