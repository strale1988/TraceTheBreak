const CACHE_VERSION = 'ttb-shell-v3';

const APP_SHELL_URL = self.registration.scope; // resolves to the directory root ("/")

// The app's own code/styles/fonts — previously missing entirely, which
// meant offline mode had a cached blank shell with no JS or CSS behind it.
// These are same-origin and plain (unhashed) filenames, so the network-first
// strategy in the fetch handler below (not a cache-first one) is what keeps
// them from ever going stale: every online load re-fetches and re-caches
// the latest build, the cached copy is only ever a fallback for offline.
const APP_SHELL_ASSETS = [
  'app.min.js',
  'style.min.css',
  'manifest.json',
  'fonts/manrope-latin-wght-normal.woff2',
  'fonts/manrope-cyrillic-wght-normal.woff2',
  'icons/TraceTheBreak.png',
  'icons/settings.png',
  'icons/fullscreen-enter.png',
  'icons/user.png',
  'icons/notification.png',
];

// Third-party libraries — self-hosted under ./vendor/ (previously fetched
// from unpkg.com/cdn.jsdelivr.net; see index.html for why) so precaching
// them is now just another same-origin request, same as APP_SHELL_ASSETS.
// Split into "eager" (loaded by every visitor via index.html's own
// <script>/<link> tags, so precaching costs nothing extra) and "lazy"
// (app.js only loads these on demand — first heatmap toggle, first admin
// phone-number edit — kept OUT of the install-time precache so most
// visitors never pay for them; they still get cached, just opportunistically
// the first time someone actually requests one, via isLocalStaticAsset in
// the fetch handler below, which doesn't care whether a URL was in this
// list or not).
// jspdf is not listed anywhere: removed from the app entirely (see
// index.html) — there was never a reason to ship or cache it.
const VENDOR_EAGER = [
  'vendor/leaflet/leaflet.css',
  'vendor/leaflet/leaflet.js',
  'vendor/leaflet/images/layers.png',
  'vendor/leaflet/images/layers-2x.png',
  'vendor/leaflet/images/marker-icon.png',
  'vendor/leaflet/images/marker-icon-2x.png',
  'vendor/leaflet/images/marker-shadow.png',
  'vendor/leaflet.markercluster/leaflet.markercluster.js',
  'vendor/leaflet.markercluster/MarkerCluster.css',
  'vendor/leaflet.markercluster/MarkerCluster.Default.css',
  'vendor/supabase-js/supabase.js',
  'vendor/flatpickr/flatpickr.min.js',
  'vendor/flatpickr/flatpickr.min.css',
  'vendor/flatpickr/l10n/sr.js',
];
// vendor/leaflet.heat/leaflet-heat.js and
// vendor/libphonenumber-js/libphonenumber-js.min.js are intentionally NOT
// listed anywhere in this file — see the comment above.

const PRECACHE_URLS = [
  APP_SHELL_URL,
  ...APP_SHELL_ASSETS,
  ...VENDOR_EAGER,
];

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_VERSION)
      .then(cache => Promise.all(
        PRECACHE_URLS.map(url =>
          fetch(url, { mode: 'same-origin' })
            .then(res => cache.put(url, res))
            .catch(() => {}) // one hiccup shouldn't block the whole precache
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
  const reqUrl = new URL(url);
  // Same-origin JS/CSS/font/icon/manifest requests are handled by pattern
  // rather than requiring every filename to be listed above — that list
  // would otherwise need updating by hand for every one of the ~77 icon
  // files (and the lazy-loaded vendor libs), and any new one would
  // silently go uncached until someone remembered to add it. This is also
  // what opportunistically caches leaflet.heat/libphonenumber-js the first
  // time app.js actually loads one, without ever forcing that download on
  // visitors who don't use those features.
  const isLocalStaticAsset = reqUrl.origin === self.location.origin
    && /\.(js|css|woff2?|png|svg|json)$/i.test(reqUrl.pathname);
  const isShellAsset = PRECACHE_URLS.includes(url) || req.mode === 'navigate' || isLocalStaticAsset;

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
