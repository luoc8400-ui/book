// 文件顶部（升级缓存版本，并将 files.json 纳入预缓存）
const CACHE = 'reader-cache-v6';
const ASSETS = ['.', './index.html', './styles.css', './app.js', './manifest.webmanifest', './files.json'];

self.addEventListener('install', (e) => {
  self.skipWaiting();
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys().then(keys =>
      Promise.all(keys.filter(k => k !== CACHE).map(k => caches.delete(k)))
    ).then(() => self.clients.claim())
  );
});

// 顶层 fetch 事件处理：为 files.json 使用稳定的缓存键（无查询参数）
// 同时保持 .txt 网络优先，失败时回退缓存
self.addEventListener('fetch', (e) => {
  const req = e.request;
  const url = new URL(req.url);
  const isManifest = url.pathname.endsWith('files.json');
  const isTxt = url.pathname.endsWith('.txt');

  if (req.mode === 'navigate') {
    e.respondWith(caches.match('./index.html').then(r => r || fetch(req)));
    return;
  }

  if (isManifest || isTxt) {
    const cacheKey = isManifest ? new Request('./files.json') : req;
    e.respondWith(
      fetch(req).then((res) => {
        const clone = res.clone();
        caches.open(CACHE).then(c => c.put(cacheKey, clone)).catch(() => {});
        return res;
      }).catch(() => caches.match(cacheKey))
    );
    return;
  }

  e.respondWith(caches.match(req).then(r => r || fetch(req)));
});