/* Service worker: the demo works offline after the first visit.
   Document loads network-first so edits are never stale; everything else is
   cache-first with a runtime fallback to the network. */
const VERSION = 'liquid-reveal-v1';
const PRECACHE = [
  './',
  './index.html',
  './assets/liquid.js',
  './favicon.svg',
  './manifest.webmanifest',
  './img.png',
  './helmet.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(VERSION).then((cache) => cache.addAll(PRECACHE)));
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k)))
    )
  );
  self.clients.claim();
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || !req.url.startsWith(self.location.origin)) return;

  /* document: network first, cache as fallback */
  if (req.mode === 'navigate'){
    event.respondWith(
      fetch(req)
        .then((res) => {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put('./index.html', copy));
          return res;
        })
        .catch(() => caches.match('./index.html'))
    );
    return;
  }

  /* everything else: cache first, then network and store for next time */
  event.respondWith(
    caches.match(req).then((hit) =>
      hit || fetch(req).then((res) => {
        if (res.ok){
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(req, copy));
        }
        return res;
      })
    )
  );
});
