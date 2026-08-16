const CACHE_VERSION = 'ttb-shell-v2';

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

// Third-party libraries actually loaded eagerly by index.html's own
// <script>/<link> tags — safe to precache since every visitor downloads
// them anyway on first paint.
// NOT included here (intentionally):
//   - jspdf: removed from the app entirely (see index.html) — precaching it
//     was pure wasted bandwidth on every install with zero benefit.
//   - leaflet.heat / libphonenumber-js: app.js deliberately lazy-loads
//     these only when a user actually toggles the heatmap or an admin
//     edits a phone number, specifically to avoid the download cost for
//     everyone else. Precaching them here forced that download for every
//     visitor anyway, silently defeating the lazy-load. They're still
//     cached — just opportunistically, the first time someone actually
//     requests them — via the CDN-runtime-cache check in the fetch handler
//     below, so they still work offline for whoever ends up using them.
const PRECACHE_URLS = [
  APP_SHELL_URL,
  ...APP_SHELL_ASSETS,
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.css',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.css',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/MarkerCluster.Default.css',
  'https://cdn.jsdelivr.net/npm/flatpickr@4.6.13/dist/flatpickr.min.css',
  'https://unpkg.com/leaflet@1.9.4/dist/leaflet.js',
  'https://unpkg.com/leaflet.markercluster@1.5.3/dist/leaflet.markercluster.js',
  'https://unpkg.com/@supabase/supabase-js@2.108.1/dist/umd/supabase.js',
  'https://cdn.jsdelivr.net/npm/flatpickr@4.6.13/dist/flatpickr.min.js',
  'https://cdn.jsdelivr.net/npm/flatpickr@4.6.13/dist/l10n/sr.js',
];

// Hosts app.js is allowed to lazy-load a script from at runtime
// (loadScriptOnce()/ensurePhoneLibLoaded()) — used below so those requests
// get opportunistically cached on first use instead of either (a) being
// precached for everyone up front, or (b) never being cached at all.
const LAZY_CDN_HOSTS = ['unpkg.com', 'cdn.jsdelivr.net'];

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
  const reqUrl = new URL(url);
  // Same-origin JS/CSS/font/icon/manifest requests are handled by pattern
  // rather than requiring every filename to be listed in APP_SHELL_ASSETS —
  // that list would otherwise need updating by hand for every one of the
  // ~77 icon files, and any new one would silently go uncached until
  // someone remembered to add it.
  const isLocalStaticAsset = reqUrl.origin === self.location.origin
    && /\.(js|css|woff2?|png|svg|json)$/i.test(reqUrl.pathname);
  // A CDN request for something NOT in PRECACHE_URLS is one of the
  // deliberately lazy-loaded libs (leaflet.heat, libphonenumber-js) being
  // fetched for the first time — cache it from here on so it's available
  // offline after that, without ever having forced the download up front.
  const isLazyCdnLib = LAZY_CDN_HOSTS.includes(reqUrl.hostname) && !PRECACHE_URLS.includes(url);
  const isShellAsset = PRECACHE_URLS.includes(url) || req.mode === 'navigate' || isLocalStaticAsset || isLazyCdnLib;

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
