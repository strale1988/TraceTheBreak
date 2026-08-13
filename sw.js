const CACHE_VERSION = 'ttb-shell-v1';

const APP_SHELL_URL = self.registration.scope; // resolves to the directory root ("/")

const PRECACHE_URLS = [
  APP_SHELL_URL,
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css',
  'https://cdn.jsdelivr.net/npm/flatpickr@4.6.13/dist/flatpickr.min.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js',
  'https://unpkg.com/leaflet.heat@0.2.0/dist/leaflet-heat.js',
  'https://unpkg.com/@supabase/supabase-js@2.108.1/dist/umd/supabase.js',
  'https://cdn.jsdelivr.net/npm/flatpickr@4.6.13/dist/flatpickr.min.js',
  'https://cdn.jsdelivr.net/npm/flatpickr@4.6.13/dist/l10n/sr.js',
  'https://unpkg.com/libphonenumber-js@1.10.51/bundle/libphonenumber-js.min.js',
  'https://unpkg.com/jspdf@2.5.1/dist/jspdf.umd.min.js'
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => Promise.all(
        PRECACHE_URLS.map(url =>
          // no-cors so opaque cross-origin CDN responses don't fail the whole install
          fetch(url, { mode: url.startsWith('http') && !url.startsWith(self.location.origin) ? 'no-cors' : 'same-origin' })
            .then(res => cache.put(url, res))
            .catch(() => {}) // one CDN hiccup shouldn't block the whole precache
        )
      ))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    caches.keys()
      .then(keys => Promise.all(
        keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return; // never intercept writes (report submissions, etc.)

  const url = req.url;
  const isShellAsset = PRECACHE_URLS.includes(url) || req.mode === 'navigate';

  if (!isShellAsset) return;

  event.respondWith(
    fetch(req)
      .then(res => {
        const copy = res.clone();
        caches.open(CACHE_VERSION).then(cache => cache.put(req, copy)).catch(() => {});
        return res;
      })
      .catch(() => caches.match(req).then(cached => cached || caches.match(APP_SHELL_URL)))
  );
});

self.addEventListener('push', (event) => {
  const data = event.data ? event.data.json() : {};
  event.waitUntil(self.registration.showNotification(data.title || 'TraceTheBreak', {
    body: data.body || '',
    icon: './icons/TraceTheBreak.png',
    data: { url: data.url || '/' },
  }));
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = event.notification.data?.url || '/';
  event.waitUntil(clients.openWindow(url));
});
