const VERSION = 'ironlog-v25';
const SHELL = [
  '/',
  '/index.html',
  '/style.css',
  '/app.js',
  '/manifest.json',
  '/icon.svg'
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
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

  // App shell: cache-first with background refresh
  event.respondWith(
    caches.match(req).then((cached) => {
      const network = fetch(req)
        .then((res) => {
          if (res.ok && url.origin === self.location.origin) {
            const copy = res.clone();
            caches.open(VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        })
        .catch(() => cached);
      return cached || network;
    })
  );
});

// Allow page to ask SW to show a notification (used for local rest-timer alerts).
self.addEventListener('message', (event) => {
  const data = event.data || {};
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
