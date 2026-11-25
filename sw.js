// CoverLanka Manager — keeps the app working offline. Data sync is handled by Firebase.
const CACHE = "coverlanka-v9-1";
const SHELL = ["./","index.html","config.js","firebase-bundle.js","logo.png","logo-dark.png","icon.png","manifest.webmanifest",
  "icons/icon-192.png","icons/icon-512.png","icons/apple-touch-icon.png",
  "fonts/outfit-latin-400-normal.woff2","fonts/outfit-latin-500-normal.woff2","fonts/outfit-latin-600-normal.woff2","fonts/outfit-latin-700-normal.woff2",
  "fonts/manrope-latin-400-normal.woff2","fonts/manrope-latin-500-normal.woff2","fonts/manrope-latin-600-normal.woff2","fonts/manrope-latin-700-normal.woff2",
  "fonts/noto-sans-sinhala-sinhala-400-normal.woff2","fonts/noto-sans-sinhala-sinhala-600-normal.woff2"];
self.addEventListener("install", e => { e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting())); });
self.addEventListener("activate", e => { e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim())); });
self.addEventListener("fetch", e => {
  const u = new URL(e.request.url);
  if (e.request.method !== "GET" || u.origin !== location.origin) return;   // Firebase & Claude go straight to the network
  const isPage = e.request.mode === "navigate" || u.pathname.endsWith("index.html") || u.pathname.endsWith("config.js");
  if (isPage) {   // newest version when online, saved copy when offline
    e.respondWith(fetch(e.request).then(r => { const c = r.clone(); caches.open(CACHE).then(ca => ca.put(e.request, c)); return r; }).catch(() => caches.match(e.request).then(r => r || caches.match("index.html"))));
  } else {
    e.respondWith(caches.match(e.request).then(r => r || fetch(e.request).then(res => { const c = res.clone(); caches.open(CACHE).then(ca => ca.put(e.request, c)); return res; })));
  }
});
