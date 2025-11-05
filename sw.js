const CACHE = 'reader-cache-v3';
const ASSETS = ['.', './index.html', './styles.css', './app.js', './manifest.webmanifest'];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  const isManifestOrTxt = url.pathname.endsWith('files.json') || url.pathname.endsWith('.txt');

  if (req.mode === 'navigate') {
    e.respondWith(caches.match('./index.html').then(r => r || fetch(req)));
    return;
  }

  if (isManifestOrTxt) {
    e.respondWith(
      fetch(req).then((res) => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(req, clone)).catch(() => {});
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  e.respondWith(caches.match(req).then(r => r || fetch(req)));
});