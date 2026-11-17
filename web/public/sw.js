const CACHE_NAME = 'dupe-shell-v1';
const PDF_CACHE_NAME = 'dupe-pdfs-v1';

self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(['/', '/index.html'])),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  if (request.method !== 'GET') {
    return;
  }
  const url = new URL(request.url);

  // Cache-with-network-fallback for PDF files so opened papers work when server is down
  if (url.pathname.startsWith('/api/papers/') && url.pathname.endsWith('/file')) {
    event.respondWith(
      caches.open(PDF_CACHE_NAME).then(async (cache) => {
        try {
          const networkResp = await fetch(request);
          if (networkResp.ok) {
            cache.put(url.pathname, networkResp.clone());
          }
          return networkResp;
        } catch {
          const cached = await cache.match(url.pathname);
          if (cached) {
            return cached;
          }
          return new Response('Server unreachable and PDF not cached locally.', {
            status: 503,
          });
        }
      }),
    );
    return;
  }

  // Network-first with cache fallback for app shell assets (JS, CSS, fonts, index.html)
  if (!url.pathname.startsWith('/api/')) {
    event.respondWith(
      caches.open(CACHE_NAME).then(async (cache) => {
        try {
          const networkResp = await fetch(request);
          if (networkResp.ok) {
            cache.put(request, networkResp.clone());
          }
          return networkResp;
        } catch {
          const cached = (await cache.match(request)) || (await cache.match('/index.html'));
          if (cached) {
            return cached;
          }
          return new Response('Offline', { status: 503 });
        }
      }),
    );
  }
});
