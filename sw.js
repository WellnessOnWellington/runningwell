/* Running Well PWA — Service Worker
   Strategy: network-first with offline fallback.
   Increment CACHE_VER on each deploy to bust stale cache. */

const CACHE_VER = 'rw-v11';
const PRECACHE = ['/', '/index.html', '/icon-192.png', '/icon-512.png'];

self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(CACHE_VER).then(c => c.addAll(PRECACHE))
  );
  self.skipWaiting();
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE_VER).map(k => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', e => {
  // Only intercept GET requests for same-origin resources
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  if (url.origin !== self.location.origin) return;
  // The 60s version poll fetches index.html with a unique ?_v=<timestamp> each time.
  // Caching those would add a fresh ~600 KB Cache Storage entry every minute that is
  // never read back, growing unbounded for the life of the long-running kiosk tab.
  if (url.searchParams.has('_v')) return;

  e.respondWith(
    fetch(e.request)
      .then(res => {
        // Cache a fresh copy for offline use
        const clone = res.clone();
        caches.open(CACHE_VER).then(c => c.put(e.request, clone));
        return res;
      })
      .catch(() => caches.match(e.request))
  );
});
