const CACHE_NAME = 'hk-sync-shell-v4';
const APP_SHELL = ['/', '/index.html', '/manifest.webmanifest', '/logo-mark.webp'];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))));
  self.clients.claim();
});

const cacheCopy = (request, response) => {
  if (response.ok) {
    const copy = response.clone();
    caches.open(CACHE_NAME).then((cache) => cache.put(request, copy));
  }
  return response;
};

self.addEventListener('fetch', (event) => {
  const requestUrl = new URL(event.request.url);
  if (event.request.method !== 'GET' || requestUrl.origin !== self.location.origin || requestUrl.pathname.startsWith('/api/')) return;

  // Hashed build assets never change, so cache-first is safe for them.
  if (requestUrl.pathname.startsWith('/assets/')) {
    event.respondWith(caches.match(event.request).then((cached) => cached || fetch(event.request).then((response) => cacheCopy(event.request, response))));
    return;
  }

  // Everything else (index.html, manifest, logo) is network-first so new deploys reach users; the cache is only an offline fallback.
  event.respondWith(fetch(event.request)
    .then((response) => cacheCopy(event.request, response))
    .catch(() => caches.match(event.request).then((cached) => cached || (event.request.mode === 'navigate' ? caches.match('/index.html') : Response.error()))));
});

// Phone / desktop notifications sent by the server (web push).
self.addEventListener('push', (event) => {
  let data = {};
  try {
    data = event.data ? event.data.json() : {};
  } catch {
    data = { body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(self.registration.showNotification(data.title || 'HK SYNC', {
    body: data.body || '',
    icon: '/icon-192.png',
    badge: '/icon-192.png',
    tag: data.tag || data.id,
    renotify: true,
    data: { link: data.link || null }
  }));
});

// Tapping a notification focuses HK SYNC (or opens it) on the right chat, task or report.
self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const link = event.notification.data?.link || null;
  event.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const open = windows.find((client) => new URL(client.url).origin === self.location.origin);
    if (open) {
      await open.focus();
      open.postMessage({ type: 'open-link', link });
      return;
    }
    await self.clients.openWindow(link ? `/?open=${encodeURIComponent(JSON.stringify(link))}` : '/');
  })());
});
