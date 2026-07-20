// TraceTheBreak service worker
// -----------------------------------------------------------------------------
// Scope: only the "app shell" — the HTML document itself and the third-party
// libraries it loads from CDNs (Leaflet, Supabase client, flatpickr, etc). The
// app already has its own, more specific caching for map tiles (Cache API,
// see fetchTileCached) and icons (ICON_CACHE_NAME), and an IndexedDB-backed
// offline report queue — this worker deliberately does NOT touch any of that,
// so it just adds "the page itself still loads with zero connectivity" on
// top of the offline behaviour that already existed.
//
// Bump CACHE_VERSION whenever you change the HTML/CSS/JS so old clients pick
// up the new version instead of being stuck on a stale cached copy.
const CACHE_VERSION = 'ttb-shell-v1';

// Same-origin document — update this if the deployed filename changes.
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

  // Leave everything else (Supabase API calls, OSRM routing/nearest, map tiles,
  // icons, Overpass, geocoding, etc.) completely alone — those already have
  // their own caching or need to always hit the network fresh.
  if (!isShellAsset) return;

  // Network-first, falling back to cache: online users always get the latest
  // build; offline users get whatever was last successfully cached.
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
