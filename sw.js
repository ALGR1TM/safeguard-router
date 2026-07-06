const CACHE = 'safeguard-router-v3';
const SHELL = [
  './', './index.html', './style.css', './app.js', './manifest.webmanifest',
  './icons/icon-192.png', './icons/icon-512.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys =>
    Promise.all(keys.filter(k => k !== CACHE && k !== 'shared').map(k => caches.delete(k)))
  ).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);

  // Web Share Target: stash the shared file, then redirect into the app (Android)
  if (req.method === 'POST' && url.searchParams.has('shared')) {
    e.respondWith((async () => {
      try {
        const form = await req.formData();
        const file = form.get('file');
        if (file) {
          const c = await caches.open('shared');
          await c.put('shared-file', new Response(file));
        }
      } catch (_) {}
      return Response.redirect('./?shared=1', 303);
    })());
    return;
  }

  // cache-first for same-origin GETs; network for the rest (CDN, geocoder)
  if (req.method === 'GET' && url.origin === location.origin) {
    e.respondWith(caches.match(req).then(hit => hit || fetch(req).then(res => {
      const copy = res.clone();
      caches.open(CACHE).then(c => c.put(req, copy)).catch(()=>{});
      return res;
    }).catch(() => caches.match('./index.html'))));
  }
});
