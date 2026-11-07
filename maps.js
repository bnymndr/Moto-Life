'use strict';
// Harita servisleri: istemci yapılandırması, hedef arama (Nominatim) ve rota proxy'si (Geoapify motosiklet / OpenRouteService araba).
// server.js içinden: require('./maps')({ app, userFromCookie })
// Ortam değişkenleri (hepsi isteğe bağlı; değerler koda yazılmaz, istemciye hiç gönderilmez):
//   GEOAPIFY_API_KEY     Motosiklet rotası (mode=motorcycle). Tanımlıysa rota sağlayıcısı budur (ROUTE_PROVIDER=auto iken).
//   ORS_API_KEY          OpenRouteService (HeiGIT) anahtarı. Yalnızca araba profili var; motosiklet profili YOKTUR.
//   ORS_BASE_URL         Varsayılan https://api.heigit.org/openrouteservice (eski api.openrouteservice.org adresi kapatıldı/kapatılıyor).
//   ROUTE_PROVIDER       auto (varsayılan) | geoapify | ors
//   ROUTE_DAILY_LIMIT    Sağlayıcıya günlük toplam istek bütçesi (kredi). Varsayılan: geoapify 2500, ors 1500.
//   ROUTE_USER_DAILY     Kullanıcı başına günlük rota isteği. Varsayılan 100.
//   MAP_TILE_URL         Karo adresi ({z}/{x}/{y} içermeli). Varsayılan: OSM standart karoları (yoğun kullanım için uygun değildir).
//   MAP_TILE_ATTRIBUTION Karo sağlayıcısının atıf metni (HTML).
//   APP_URL              Nominatim'e gönderilen User-Agent içinde kullanılır (politika gereği uygulamayı tanıtmalı).

const OSM_TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const OSM_ATTR = '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> katkıda bulunanlar';

// Sağlayıcı yetenekleri. avoid: bu profilde gerçekten uygulanabilen kaçınma seçenekleri (Geoapify belgesine göre
// otoyol/ücretli yol kaçınma yalnızca araba/kamyon/otobüs modlarında çalışır, motosiklette yalnızca feribot).
const PROVIDERS = {
  geoapify: { profile: 'motorcycle', label: 'Motosiklet rotası', avoid: ['ferries'], dailyDefault: 2500,
    attr: 'Rota: <a href="https://www.geoapify.com/" target="_blank" rel="noopener">Powered by Geoapify</a>' },
  ors: { profile: 'driving-car', label: 'Araç rotası · motosiklet için optimize değil', avoid: ['highways', 'tolls', 'ferries'], dailyDefault: 1500,
    attr: 'Rota: <a href="https://openrouteservice.org/" target="_blank" rel="noopener">openrouteservice.org</a> (HeiGIT)' }
};

module.exports = function mountMaps({ app, userFromCookie }) {
  const GEO_KEY = process.env.GEOAPIFY_API_KEY || '';
  const ORS_KEY = process.env.ORS_API_KEY || '';
  const ORS_BASE = (process.env.ORS_BASE_URL || 'https://api.heigit.org/openrouteservice').replace(/\/+$/, '');
  const want = String(process.env.ROUTE_PROVIDER || 'auto').toLowerCase();
  const provider = want === 'geoapify' ? (GEO_KEY ? 'geoapify' : null) : want === 'ors' ? (ORS_KEY ? 'ors' : null) : (GEO_KEY ? 'geoapify' : ORS_KEY ? 'ors' : null);
  const P = provider ? PROVIDERS[provider] : null;
  const DAILY_TOTAL = Number(process.env.ROUTE_DAILY_LIMIT) || (P ? P.dailyDefault : 0);
  const DAILY_USER = Number(process.env.ROUTE_USER_DAILY) || 100;
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

  // Kullanıcı başına dakikalık istek sınırı
  const hits = new Map();
  function limited(uid, max) {
    const now = Date.now(), arr = (hits.get(uid) || []).filter(t => now - t < 60000);
    if (arr.length >= max) { hits.set(uid, arr); return true; }
    arr.push(now); hits.set(uid, arr); return false;
  }
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 60000)) hits.delete(k); }, 5 * 60000).unref();

  // Günlük rota bütçesi: ücretsiz kotayı (ve kullanıcı başına kötüye kullanımı) korur. Önbellekten dönen yanıtlar bütçeden düşmez.
  const usage = { day: '', total: 0, users: new Map() };
  const today = () => new Date().toISOString().slice(0, 10);
  function spend(uid, cost) {
    if (usage.day !== today()) { usage.day = today(); usage.total = 0; usage.users.clear(); }
    const mine = usage.users.get(uid) || 0;
    if (mine >= DAILY_USER) return 'Bugünlük rota hakkın doldu. Yarın tekrar dene.';
    if (usage.total + cost > DAILY_TOTAL) return 'Rota servisinin günlük kotası doldu. Daha sonra tekrar dene.';
    usage.total += cost; usage.users.set(uid, mine + 1); return null;
  }
  // Yönetici için: sağlayıcı reddederse (ör. geçersiz anahtar, kapanmış adres) sırları yazmadan, 10 dakikada bir uyar.
  let lastWarn = 0;
  function warn(msg) { if (Date.now() - lastWarn > 600000) { lastWarn = Date.now(); console.warn('[maps] ' + msg); } }

  // Basit TTL önbelleği
  function cache(ttl, max) {
    const m = new Map();
    return {
      get(k) { const e = m.get(k); if (!e) return undefined; if (e.t < Date.now()) { m.delete(k); return undefined; } return e.v; },
      set(k, v) { if (m.size >= max) m.delete(m.keys().next().value); m.set(k, { v, t: Date.now() + ttl }); }
    };
  }
  const geoCache = cache(6 * 3600 * 1000, 500), routeCache = cache(5 * 60 * 1000, 200);

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

  // ---------- İstemci yapılandırması (anahtarlar ASLA buradan geçmez) ----------
  app.get('/api/maps/config', (req, res) => {
    if (!needAuth(req, res)) return;
    res.json({ tileUrl, tileAttr, tileMax: 19, routing: !!P,
      route: P ? { provider, profile: P.profile, label: P.label, avoid: P.avoid, attr: P.attr } : null });
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

  // ---------- Rota ----------
  // Geometri sadeleştirme (Douglas-Peucker, yinelemeli): çizgiyi gözle ayırt edilemeyecek kadar (≈4 m) sadeleştirir; yük küçülür,
  // rotadan sapma tespiti etkilenmez. Mesafe/süre sağlayıcının verdiği değerlerdir, sadeleştirmeden etkilenmez.
  function simplify(pts, tol) {
    if (pts.length < 3) return pts;
    const kx = 111320 * Math.cos(pts[0][0] * Math.PI / 180), ky = 110540;
    const xy = pts.map(p => [p[1] * kx, p[0] * ky]), keep = new Uint8Array(pts.length);
    keep[0] = keep[pts.length - 1] = 1;
    const stack = [[0, pts.length - 1]];
    while (stack.length) {
      const [s, e] = stack.pop(); let maxD = 0, idx = -1;
      const ax = xy[s][0], ay = xy[s][1], dx = xy[e][0] - ax, dy = xy[e][1] - ay, l2 = dx * dx + dy * dy;
      for (let i = s + 1; i < e; i++) {
        const t = l2 ? Math.max(0, Math.min(1, ((xy[i][0] - ax) * dx + (xy[i][1] - ay) * dy) / l2)) : 0;
        const d = Math.hypot(xy[i][0] - (ax + t * dx), xy[i][1] - (ay + t * dy));
        if (d > maxD) { maxD = d; idx = i; }
      }
      if (maxD > tol && idx > 0) { keep[idx] = 1; stack.push([s, idx], [idx, e]); }
    }
    return pts.filter((_, i) => keep[i]);
  }
  function compact(pts) { for (const tol of [4, 15, 40]) { const s = simplify(pts, tol); if (s.length <= 5000) return s; } return simplify(pts, 100); }

  class RouteError extends Error { constructor(status, msg) { super(msg); this.status = status; } }

  async function viaGeoapify(a, b, avoid) {
    const p = new URLSearchParams({ waypoints: `${a[0]},${a[1]}|${b[0]},${b[1]}`, mode: 'motorcycle', format: 'geojson', apiKey: GEO_KEY });
    if (avoid.length) p.set('avoid', avoid.join('|'));
    const r = await getJson('https://api.geoapify.com/v1/routing?' + p, { headers: { Accept: 'application/json' } }, 15000);
    const f = r.ok && r.body && Array.isArray(r.body.features) && r.body.features[0];
    if (!f || !f.geometry || !Array.isArray(f.geometry.coordinates)) {
      if (r.status === 401 || r.status === 403) warn('Geoapify anahtarı reddedildi (HTTP ' + r.status + ').');
      if (r.status === 429) throw new RouteError(429, 'Rota servisinin günlük kotası doldu. Daha sonra tekrar dene.');
      if (r.status === 400 || r.status === 404) throw new RouteError(404, 'Bu iki nokta arasında rota bulunamadı. Hedefi bir yola daha yakın seç.');
      throw new RouteError(502, 'Rota servisi şu an yanıt vermiyor.');
    }
    const lines = f.geometry.type === 'MultiLineString' ? f.geometry.coordinates : [f.geometry.coordinates], pts = [];
    for (const l of lines) for (const c of l) {
      const q = [c[1], c[0]], last = pts[pts.length - 1];
      if (!last || last[0] !== q[0] || last[1] !== q[1]) pts.push(q);          // bacaklar arasındaki yinelenen uç nokta
    }
    const pr = f.properties || {};
    return { distance: Number(pr.distance) || 0, duration: Number(pr.time) || 0, coords: pts, toll: !!pr.toll, ferry: !!pr.ferry };
  }

  async function viaOrs(a, b, avoid) {
    const body = { coordinates: [[a[1], a[0]], [b[1], b[0]]], instructions: false };
    if (avoid.length) body.options = { avoid_features: avoid.map(x => (x === 'tolls' ? 'tollways' : x)) };
    const r = await getJson(ORS_BASE + '/v2/directions/driving-car/geojson', {
      method: 'POST', headers: { Authorization: ORS_KEY, 'Content-Type': 'application/json', Accept: 'application/geo+json' }, body: JSON.stringify(body)
    }, 15000);
    const f = r.ok && r.body && Array.isArray(r.body.features) && r.body.features[0];
    if (!f || !f.geometry || !Array.isArray(f.geometry.coordinates)) {
      const err = r.body && r.body.error, msg = String(err && err.message || err || '');
      if (r.status === 401 || r.status === 403) warn('OpenRouteService anahtarı/adresi reddedildi (HTTP ' + r.status + '). Anahtarın api.heigit.org için geçerli olduğunu kontrol et.');
      if (r.status === 429) throw new RouteError(429, 'Rota servisinin kotası doldu. Biraz sonra tekrar dene.');
      if (r.status === 404 || (err && err.code === 2010)) {
        const which = /coordinate (\d)/.exec(msg);
        throw new RouteError(404, which && which[1] === '0' ? 'Bulunduğun konumun yakınında yol bulunamadı.'
          : which && which[1] === '1' ? 'Seçtiğin hedefin yakınında yol bulunamadı. Hedefi bir yola daha yakın seç.' : 'Bu iki nokta arasında rota bulunamadı.');
      }
      throw new RouteError(502, 'Rota servisi şu an yanıt vermiyor.');
    }
    const s = (f.properties && f.properties.summary) || {};
    return { distance: Number(s.distance) || 0, duration: Number(s.duration) || 0, coords: f.geometry.coordinates.map(c => [c[1], c[0]]), toll: null, ferry: null };
  }

  // GET /api/route?from=lat,lon&to=lat,lon&avoid=highways,tolls,ferries
  app.get('/api/route', async (req, res) => {
    const u = needAuth(req, res); if (!u) return;
    if (!P) return res.status(503).json({ error: 'Rota servisi yapılandırılmadı.', code: 'not_configured' });
    const [a, b] = ['from', 'to'].map(k => String(req.query[k] || '').split(',').map(num));
    if (a.length !== 2 || b.length !== 2 || !okLat(a[0]) || !okLon(a[1]) || !okLat(b[0]) || !okLon(b[1])) return res.status(400).json({ error: 'Geçersiz koordinat.' });
    const uid = String(u.id || u.username || 'u');
    if (limited('r' + uid, 12)) return res.status(429).json({ error: 'Çok sık rota istedin. Biraz bekle.' });
    // Yalnızca bu sağlayıcı/profilde gerçekten desteklenen kaçınmalar uygulanır; diğerleri "ignoredAvoid" olarak bildirilir
    const asked = [...new Set(String(req.query.avoid || '').split(',').map(s => s.trim()).filter(x => ['highways', 'tolls', 'ferries'].includes(x)))];
    const avoid = asked.filter(x => P.avoid.includes(x)), ignoredAvoid = asked.filter(x => !P.avoid.includes(x));
    const key = provider + '|' + [a, b].map(c => c.map(v => v.toFixed(4)).join(',')).join('>') + '|' + avoid.slice().sort().join(',');
    const hit = routeCache.get(key);
    if (hit) return res.json({ ...hit, ignoredAvoid, cached: true });
    const over = spend(uid, 1 + (provider === 'geoapify' ? avoid.length : 0));
    if (over) return res.status(429).json({ error: over });
    try {
      const r = provider === 'geoapify' ? await viaGeoapify(a, b, avoid) : await viaOrs(a, b, avoid);
      const out = { provider, profile: P.profile, label: P.label, distance: r.distance, duration: r.duration, toll: r.toll, ferry: r.ferry,
        avoid, coords: compact(r.coords) };
      routeCache.set(key, out);
      res.json({ ...out, ignoredAvoid });
    } catch (e) {
      if (e instanceof RouteError) return res.status(e.status).json({ error: e.message });
      res.status(502).json({ error: 'Rota servisine ulaşılamadı.' });
    }
  });
};
