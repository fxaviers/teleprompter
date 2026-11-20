const CACHE_NAME = 'promptcam-v4';

const ASSETS = [
  './',
  './index.html',
  './manifest.webmanifest',
  './css/styles.css?v=4',
  './js/app.js?v=4',
  './js/prompter.js?v=4',
  './js/voice.js?v=4',
  './js/storage.js?v=4',
  './js/ui-polyfills.js?v=4',
  './icons/icon.svg',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      const urls = ASSETS.map((asset) => new URL(asset, self.registration.scope).href);
      await Promise.all(
        urls.map(async (url) => {
          const response = await fetch(new Request(url, { cache: 'reload' }));
          if (!response.ok) {
            throw new Error(`Failed to precache ${url}: ${response.status}`);
          }
          await cache.put(url, response);
        })
      );
    }).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys
          .filter((key) => key !== CACHE_NAME)
          .map((key) => caches.delete(key))
      )
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;

  event.respondWith(
    caches.open(CACHE_NAME).then(async (cache) => {
      try {
        const networkResponse = await fetch(request);
        if (networkResponse && networkResponse.ok && networkResponse.type === 'basic') {
          cache.put(request, networkResponse.clone());
        }
        return networkResponse;
      } catch {
        const cached = await cache.match(request);
        if (cached) return cached;

        if (request.mode === 'navigate') {
          const fallbackUrl = new URL('./index.html', self.registration.scope).href;
          const fallback = await cache.match(fallbackUrl);
          if (fallback) return fallback;
        }

        return Response.error();
      }
    })
  );
});
