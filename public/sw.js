// Önce ağ, olmazsa önbellek: güncel dosya her zaman öncelikli, yükleme hızlanır, çevrimdışıyken kabuk açılır.
const CACHE = 'motolife-v1';
self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(['/', '/splash.jpg', '/icons/icon-192.png'])).then(() => self.skipWaiting()));
});
self.addEventListener('activate', e => {
  e.waitUntil(caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', e => {
  const u = new URL(e.request.url);
  // API, soket ve parametreli adresler (ör. şifre sıfırlama bağlantısı) önbelleğe alınmaz
  if (e.request.method !== 'GET' || u.origin !== location.origin || u.search ||
      u.pathname.startsWith('/api') || u.pathname.startsWith('/socket.io')) return;
  e.respondWith(
    fetch(e.request).then(r => {
      if (r.ok) { const copy = r.clone(); caches.open(CACHE).then(c => c.put(e.request, copy)); }
      return r;
    }).catch(() => caches.match(e.request).then(r => r || caches.match('/')))
  );
});
