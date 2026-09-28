// BodyFactory Gym service worker.
// - Versioned static files (?v=...) are immutable: served from cache first.
// - Pages and unversioned files: network first, cache only as offline fallback.
// - API, admin panel, robots.txt and sitemap.xml are never cached (inventory must always be fresh).
// __BUILD__ is replaced by the server with a hash of the frontend code, so every deploy
// installs a new worker and the activate step removes the previous cache.
const PREFIX = 'bf-';
const VERSION = `${PREFIX}__BUILD__`;
const SHELL = ['/', '/css/styles.css?v=__BUILD__', '/js/app.js?v=__BUILD__', '/js/ui.js?v=__BUILD__', '/img/logo-96.webp', '/img/logo-192.webp', '/manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const p = url.pathname;
  if (p.startsWith('/api/') || p.startsWith('/admin') || p === '/sw.js' || p === '/robots.txt' || p === '/sitemap.xml') return;

  if (req.mode === 'navigate') { e.respondWith(networkFirst(req)); return; }
  if (url.searchParams.has('v')) { e.respondWith(cacheFirst(req)); return; }
  e.respondWith(networkFirst(req));
});

async function cacheFirst(req) {
  const cache = await caches.open(VERSION);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await fetch(req);
  if (res.ok) cache.put(req, res.clone());
  return res;
}

async function networkFirst(req) {
  const cache = await caches.open(VERSION);
  try {
    const res = await fetch(req, { cache: 'no-cache' });
    if (res.ok) cache.put(req, res.clone());
    return res;
  } catch {
    return (await cache.match(req)) || (req.mode === 'navigate' ? await cache.match('/') : Response.error());
  }
}
