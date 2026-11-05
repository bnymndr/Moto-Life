'use strict';
// Harita servisleri: istemci yapılandırması, hedef arama (Nominatim) ve rota (OpenRouteService) proxy'si.
// server.js içinden: require('./maps')({ app, userFromCookie })
// Ortam değişkenleri (hepsi isteğe bağlı; değerler koda yazılmaz):
//   ORS_API_KEY          Rota servisi anahtarı. Tanımlı değilse rota özelliği kapalı kalır, arama çalışır.
//   MAP_TILE_URL         Karo adresi ({z}/{x}/{y} içermeli). Varsayılan: OSM standart karoları (yoğun kullanım için uygun değildir).
//   MAP_TILE_ATTRIBUTION Karo sağlayıcısının atıf metni (HTML).
//   APP_URL              Nominatim'e gönderilen User-Agent içinde kullanılır (politika gereği uygulamayı tanıtmalı).

const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> katkıda bulunanlar';

module.exports = function mountMaps({ app, userFromCookie }) {
  const ORS_KEY = process.env.ORS_API_KEY || '';
  const UA = `MotoLife/1.0 (${process.env.APP_URL || 'yerel gelistirme'})`;
  const tileUrl = process.env.MAP_TILE_URL || OSM_TILES;
  const tileAttr = process.env.MAP_TILE_ATTRIBUTION || OSM_ATTR;

  const needAuth = (req, res) => {
    const u = userFromCookie(req.headers.cookie);
    if (!u) { res.status(401).json({ error: 'Giriş gerekli.' }); return null; }
    return u;
  };
  const num = v => (v === '' || v == null ? NaN : Number(v));
  const okLat = v => Number.isFinite(v) && v >= -90 && v <= 90;
  const okLon = v => Number.isFinite(v) && v >= -180 && v <= 180;

  // Kullanıcı başına istek sınırı (dakikada)
  const hits = new Map();
  function limited(uid, max) {
    const now = Date.now(), arr = (hits.get(uid) || []).filter(t => now - t < 60000);
    if (arr.length >= max) { hits.set(uid, arr); return true; }
    arr.push(now); hits.set(uid, arr); return false;
  }
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 60000)) hits.delete(k); }, 5 * 60000).unref();

  // Basit TTL önbelleği
  function cache(ttl, max) {
    const m = new Map();
    return {
      get(k) { const e = m.get(k); if (!e) return undefined; if (e.t < Date.now()) { m.delete(k); return undefined; } return e.v; },
      set(k, v) { if (m.size >= max) m.delete(m.keys().next().value); m.set(k, { v, t: Date.now() + ttl }); }
    };
  }
  const geoCache = cache(6 * 3600 * 1000, 500), routeCache = cache(2 * 60 * 1000, 200);

  // Nominatim politikası: tüm uygulama için saniyede en fazla 1 istek → sıraya al
  let chain = Promise.resolve(), lastAt = 0;
  function queued(fn) {
    const run = chain.then(async () => {
      const wait = Math.max(0, lastAt + 1100 - Date.now());
      if (wait) await new Promise(r => setTimeout(r, wait));
      lastAt = Date.now();
      return fn();
    });
    chain = run.catch(() => {});
    return run;
  }
  async function getJson(url, opts = {}, ms = 9000) {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), ms);
    try {
      const r = await fetch(url, { ...opts, signal: ac.signal });
      const body = await r.json().catch(() => null);
      return { status: r.status, ok: r.ok, body };
    } finally { clearTimeout(t); }
  }

  // ---------- İstemci yapılandırması ----------
  app.get('/api/maps/config', (req, res) => {
    if (!needAuth(req, res)) return;
    res.json({ tileUrl, tileAttr, tileMax: 19, routing: !!ORS_KEY });
  });

  // ---------- Hedef arama (yazarken değil, düğmeyle; politika gereği otomatik tamamlama yok) ----------
  app.get('/api/geocode', async (req, res) => {
    const u = needAuth(req, res); if (!u) return;
    const q = String(req.query.q || '').trim().replace(/\s+/g, ' ');
    if (q.length < 3 || q.length > 120) return res.status(400).json({ error: 'En az 3 karakter yaz.' });
    if (limited(u.id || u.username || 'u', 20)) return res.status(429).json({ error: 'Çok sık arama yaptın. Biraz bekle.' });
    const lat = num(req.query.lat), lon = num(req.query.lon);
    const near = okLat(lat) && okLon(lon);
    // Sonuçları bulunulan bölgeye yaklaştır (kısıtlamaz): önbellek anahtarı için yaklaşık 0,5° kutu
    const key = q.toLowerCase() + (near ? `|${Math.round(lat * 2)}|${Math.round(lon * 2)}` : '');
    const hit = geoCache.get(key);
    if (hit) return res.json({ results: hit });
    const p = new URLSearchParams({ q, format: 'jsonv2', limit: '6', 'accept-language': 'tr', addressdetails: '0' });
    if (near) p.set('viewbox', [lon - 1, lat + 1, lon + 1, lat - 1].map(v => v.toFixed(4)).join(','));   // sol,üst,sağ,alt
    try {
      const r = await queued(() => getJson('https://nominatim.openstreetmap.org/search?' + p, { headers: { 'User-Agent': UA, Accept: 'application/json' } }));
      if (!r.ok || !Array.isArray(r.body)) return res.status(502).json({ error: 'Arama servisi şu an yanıt vermiyor.' });
      const results = r.body.map(x => {
        const full = String(x.display_name || '');
        return { title: String(x.name || full.split(',')[0] || '').slice(0, 80), subtitle: full.slice(0, 160), lat: Number(x.lat), lon: Number(x.lon) };
      }).filter(x => okLat(x.lat) && okLon(x.lon));
      geoCache.set(key, results);
      res.json({ results });
    } catch { res.status(502).json({ error: 'Arama servisine ulaşılamadı.' }); }
  });

  // ---------- Rota: yalnızca ORS_API_KEY tanımlıysa ----------
  // Profil: driving-car (araç rotası). Motosiklet için özel bir profil KULLANILMIYOR; istemci bunu kullanıcıya belirtir.
  app.get('/api/route', async (req, res) => {
    const u = needAuth(req, res); if (!u) return;
    if (!ORS_KEY) return res.status(503).json({ error: 'Rota servisi yapılandırılmadı.', code: 'not_configured' });
    const [a, b] = ['from', 'to'].map(k => String(req.query[k] || '').split(',').map(num));
    if (a.length !== 2 || b.length !== 2 || !okLat(a[0]) || !okLon(a[1]) || !okLat(b[0]) || !okLon(b[1])) return res.status(400).json({ error: 'Geçersiz koordinat.' });
    if (limited('r' + (u.id || u.username || 'u'), 12)) return res.status(429).json({ error: 'Çok sık rota istedin. Biraz bekle.' });
    const key = [a, b].map(c => c.map(v => v.toFixed(4)).join(',')).join('>');
    const hit = routeCache.get(key);
    if (hit) return res.json(hit);
    try {
      const r = await getJson('https://api.openrouteservice.org/v2/directions/driving-car/geojson', {
        method: 'POST',
        headers: { Authorization: ORS_KEY, 'Content-Type': 'application/json', Accept: 'application/geo+json' },
        body: JSON.stringify({ coordinates: [[a[1], a[0]], [b[1], b[0]]], instructions: false })
      }, 15000);
      const f = r.ok && r.body && r.body.features && r.body.features[0];
      if (!f || !f.geometry || !Array.isArray(f.geometry.coordinates)) {
        const msg = r.status === 404 ? 'Bu iki nokta arasında rota bulunamadı.' : 'Rota servisi şu an yanıt vermiyor.';
        return res.status(r.status === 404 ? 404 : 502).json({ error: msg });
      }
      const s = (f.properties && f.properties.summary) || {};
      const out = {
        profile: 'driving-car',
        distance: Number(s.distance) || 0,      // metre
        duration: Number(s.duration) || 0,      // saniye (araç süresi; motosiklet için kesin değildir)
        coords: f.geometry.coordinates.map(c => [c[1], c[0]])   // [lat, lon]
      };
      routeCache.set(key, out);
      res.json(out);
    } catch { res.status(502).json({ error: 'Rota servisine ulaşılamadı.' }); }
  });
};
