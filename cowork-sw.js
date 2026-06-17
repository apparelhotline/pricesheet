/* Cowork PWA service worker.
   App-shell caching only. GitHub API calls are always network (never cached). */
const CACHE = 'cowork-shell-v1';
const SHELL = [
  './cowork.html',
  './manifest.webmanifest',
  './assets/cowork-icon-192.png',
  './assets/cowork-icon-512.png',
  './assets/cowork-icon-180.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // Never cache API traffic — always live.
  if (url.hostname === 'api.github.com' || e.request.method !== 'GET') return;
  // App shell: network-first, fall back to cache when offline.
  e.respondWith(
    fetch(e.request).then((res) => {
      const copy = res.clone();
      caches.open(CACHE).then((c) => c.put(e.request, copy)).catch(() => {});
      return res;
    }).catch(() => caches.match(e.request))
  );
});
