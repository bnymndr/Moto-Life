'use strict';
/* Harita ve Navigasyon ekranı.
   index.html ilk açılışta /map.css ve bu dosyayı yükler → window.MotoMap.mount(kök, {}) → activate()/deactivate().
   Harita: Leaflet 1.9.4 (cdnjs, sabit sürüm). Karo adresi, arama ve rota sunucudan (maps.js) gelir.
   Dışa açık API:  MotoMap.mount(root) → { activate, deactivate, setRiders(liste), flyToMe }
   Diğer sürücüler: setRiders([{ id, name, lat, lon, speed (m/sn, ops.), leader (ops.) }]) — gerçek veri bağlanana kadar çağrılmaz. */
(function () {
  /* ================= Çekirdek: tarayıcıdan bağımsız hesaplar (Node ile test edilir) ================= */
  const toRad = d => d * Math.PI / 180;
  function haversine(lat1, lon1, lat2, lon2) {
    const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  const nf1 = new Intl.NumberFormat('tr-TR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  function fmtDist(m) {
    if (!isFinite(m)) return '—';
    if (m < 1000) return Math.round(m) + ' m';
    return m < 100000 ? nf1.format(m / 1000) + ' km' : Math.round(m / 1000) + ' km';
  }
  function fmtClock(sec) {
    sec = Math.max(0, Math.floor(sec));
    const h = Math.floor(sec / 3600), m = Math.floor(sec % 3600 / 60), s = sec % 60, p = n => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(s)}` : `${p(m)}:${p(s)}`;
  }
  function fmtEta(sec) {
    if (!isFinite(sec)) return '—';
    const m = Math.max(1, Math.round(sec / 60));
    return m < 60 ? m + ' dk' : Math.floor(m / 60) + ' sa ' + (m % 60) + ' dk';
  }
  const kmh = ms => (ms == null || !isFinite(ms) ? null : ms * 3.6);

  class RouteTracker {
    // distance (sağlayıcının verdiği gerçek rota mesafesi, m) verilirse, sadeleştirilmiş geometrinin kısalığı oranla düzeltilir
    constructor(coords, duration, distance) {
      this.c = coords; this.dur = duration; this.cum = [0];
      for (let i = 1; i < coords.length; i++) this.cum.push(this.cum[i - 1] + haversine(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]));
      const geo = this.cum[this.cum.length - 1] || 0;
      this.scale = distance > 0 && geo > 0 && distance / geo > 0.8 && distance / geo < 1.25 ? distance / geo : 1;
      if (this.scale !== 1) this.cum = this.cum.map(v => v * this.scale);
      this.total = this.cum[this.cum.length - 1] || 0;
    }
    // Konumun rotaya en yakın noktası: rotadan sapma (m) ve kalan mesafe (m)
    progress(lat, lon) {
      if (this.c.length < 2) return { off: 0, remaining: 0 };
      const kx = 111320 * Math.cos(toRad(lat)), ky = 110540;
      let best = Infinity, along = 0;
      for (let i = 0; i < this.c.length - 1; i++) {
        const ax = (this.c[i][1] - lon) * kx, ay = (this.c[i][0] - lat) * ky;
        const dx = (this.c[i + 1][1] - lon) * kx - ax, dy = (this.c[i + 1][0] - lat) * ky - ay, l2 = dx * dx + dy * dy;
        const t = l2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2)) : 0;
        const d = Math.hypot(ax + t * dx, ay + t * dy);
        if (d < best) { best = d; along = this.cum[i] + t * (this.cum[i + 1] - this.cum[i]); }
      }
      return { off: best, remaining: Math.max(0, this.total - along) };
    }
  }
  // Tahmini kalan süre (sn): planlanan ortalama hız ile, gidilen yolda ölçülen gerçek hareket hızının karışımı.
  // Ölçüm yetersizse (<500 m / <60 sn) yalnızca plan; ölçüm arttıkça (3 km'de tam) gerçek hıza kayar. API çağrısı gerektirmez.
  function estimateEta(o) {
    const remaining = o.remaining, planDist = o.planDist, planDur = o.planDur, movedM = o.movedM || 0, movingS = o.movingS || 0;
    if (!(remaining >= 0) || !(planDist > 0) || !(planDur > 0)) return NaN;
    const vPlan = planDist / planDur, w = movedM >= 500 && movingS >= 60 ? Math.min(1, movedM / 3000) : 0;
    const v = Math.min(40, Math.max(2, (1 - w) * vPlan + w * (movingS > 0 ? movedM / movingS : vPlan)));
    return remaining / v;
  }

  const Core = { haversine, fmtDist, fmtClock, fmtEta, RouteTracker, estimateEta };
  if (typeof module !== 'undefined' && module.exports) module.exports = Core;
  if (typeof window === 'undefined') return;

  /* ================= Tarayıcı: harita ekranı ================= */
  const LEAFLET = 'https://cdnjs.cloudflare.com/ajax/libs/leaflet/1.9.4/leaflet.min.';
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const store = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : v; } catch { return d; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch {} }
  };
  const ic = d => `<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
  const ICON = {
    search: ic('<circle cx="11" cy="11" r="7"/><path d="M21 21l-4.3-4.3"/>'),
    plus: ic('<path d="M12 5v14M5 12h14"/>'),
    minus: ic('<path d="M5 12h14"/>'),
    locate: ic('<circle cx="12" cy="12" r="4"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/>'),
    menu: ic('<path d="M4 7h16M4 12h16M4 17h16"/>'),
    close: ic('<path d="M6 6l12 12M18 6L6 18"/>'),
    play: '<svg viewBox="0 0 24 24" width="26" height="26" fill="currentColor" aria-hidden="true"><path d="M8 5.5v13a1 1 0 0 0 1.5.86l10.5-6.5a1 1 0 0 0 0-1.72L9.5 4.64A1 1 0 0 0 8 5.5z"/></svg>',
    stop: '<svg viewBox="0 0 24 24" width="24" height="24" fill="currentColor" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    nav: ic('<path d="M3 11l18-8-8 18-2-8-8-2z"/>')
  };
  const PIN = '<svg viewBox="0 0 32 40" width="32" height="40" aria-hidden="true"><path d="M16 39S3 26.5 3 15a13 13 0 0 1 26 0c0 11.500-13 24-13 24z" fill="#EA8621" stroke="#031420" stroke-width="2"/><circle cx="16" cy="15" r="5" fill="#031420"/></svg>';

  function loadScripts(list) {
    return list.reduce((p, src) => p.then(() => new Promise((res, rej) => {
      const name = src.includes('core') ? 'RideCore' : 'RideStore';
      if (window[name]) return res();
      const sc = document.createElement('script'); sc.src = src;
      sc.onload = () => res(); sc.onerror = () => { sc.remove(); rej(new Error('Sürüş modülü yüklenemedi.')); };
      document.head.appendChild(sc);
    })), Promise.resolve());
  }
  let leafletP = null;
  function loadLeaflet() {
    if (window.L && window.L.map) return Promise.resolve();
    if (leafletP) return leafletP;
    leafletP = new Promise((res, rej) => {
      if (!document.getElementById('mm-leaflet-css')) {
        const l = document.createElement('link'); l.id = 'mm-leaflet-css'; l.rel = 'stylesheet'; l.href = LEAFLET + 'css'; l.crossOrigin = 'anonymous';
        document.head.appendChild(l);
      }
      const s = document.createElement('script'); s.src = LEAFLET + 'js'; s.crossOrigin = 'anonymous';
      s.onload = () => (window.L && window.L.map ? res() : (leafletP = null, rej(new Error('Harita kütüphanesi hazır değil.'))));
      s.onerror = () => { leafletP = null; s.remove(); rej(new Error('Harita kütüphanesi yüklenemedi. İnternet bağlantını kontrol et.')); };
      document.head.appendChild(s);
    });
    return leafletP;
  }

  const TEMPLATE = `
  <div class="mm" id="mm" data-theme="dark">
    <div class="mm-map" id="mm-map"></div>
    <div class="mm-load" id="mm-load"><p id="mm-load-msg">Harita yükleniyor…</p><button type="button" class="mm-retry" id="mm-retry" hidden>Tekrar dene</button></div>

    <div class="mm-top">
      <div id="mm-head">
        <form class="mm-search" id="mm-form" role="search" autocomplete="off">
          <span class="mm-sico">${ICON.search}</span>
          <input id="mm-q" type="search" inputmode="search" enterkeyhint="search" placeholder="Nereye gidiyorsun?" aria-label="Gidilecek yeri ara" maxlength="120">
          <button type="submit" class="mm-go" id="mm-go">Ara</button>
        </form>
        <div class="mm-navbar" id="mm-navbar" hidden>
          <div class="mm-navinfo">
            <div class="mm-navto" id="mm-navto"></div>
            <div class="mm-navnums"><b id="mm-navrem">—</b><span id="mm-naveta"></span></div>
            <div class="mm-navnote" id="mm-navnote"></div>
          </div>
          <div class="mm-nbtns">
            <button type="button" class="mm-nb" id="mm-newdest">Yeni hedef</button>
            <button type="button" class="mm-nb stop" id="mm-navstop">Bitir</button>
          </div>
        </div>
      </div>
      <div class="mm-results" id="mm-results" hidden></div>
      <div class="mm-chip" id="mm-gps" data-s="warn">GPS aranıyor…</div>
    </div>

    <div class="mm-side" id="mm-side">
      <button type="button" class="mm-btn" id="mm-zin" aria-label="Yakınlaştır">${ICON.plus}</button>
      <button type="button" class="mm-btn" id="mm-zout" aria-label="Uzaklaştır">${ICON.minus}</button>
      <button type="button" class="mm-btn" id="mm-loc" aria-label="Konumuma dön">${ICON.locate}</button>
      <button type="button" class="mm-btn" id="mm-mbtn" aria-label="Harita ayarları" aria-expanded="false">${ICON.menu}</button>
      <div class="mm-menu" id="mm-menu" hidden>
        <div class="mm-mrow"><span>Harita teması</span>
          <div class="mm-seg"><button type="button" data-th="dark">Koyu</button><button type="button" data-th="light">Açık</button></div></div>
        <label class="mm-mrow"><span>Sürüşte ekranı açık tut</span><input type="checkbox" id="mm-wake"></label>
        <div class="mm-mrow mm-saved"><span id="mm-savedtxt">Kayıtlı sürüş: —</span><button type="button" class="mm-mini" id="mm-syncbtn" hidden>Eşitle</button></div>
        <p class="mm-note" id="mm-synchint" hidden></p>
        <p class="mm-note" id="mm-wakenote">Konum kaydı için sürüş boyunca uygulamayı ön planda ve ekranı açık tut. Ekran kilitlenirse ya da başka uygulamaya geçersen konum alınamayabilir.</p>
      </div>
    </div>

    <div class="mm-toast" id="mm-toast" hidden></div>

    <div class="mm-bottom">
      <div class="mm-attr" id="mm-attr"></div>
      <div class="mm-card" id="mm-dest" hidden>
        <div class="mm-dtop">
          <div class="mm-dtxt"><div class="mm-dtitle" id="mm-dtitle"></div><div class="mm-dsub" id="mm-dsub"></div></div>
          <button type="button" class="mm-x" id="mm-dclear" aria-label="Hedefi kaldır">${ICON.close}</button>
        </div>
        <div class="mm-dline" id="mm-dline"></div>
        <div class="mm-rinfo" id="mm-rinfo" hidden>
          <div class="mm-rnums"><b id="mm-rdist">—</b><span id="mm-reta"></span></div>
          <div class="mm-rlabel" id="mm-rlabel"></div>
        </div>
        <div class="mm-chips" id="mm-chips" hidden></div>
        <div class="mm-dbtns">
          <button type="button" class="mm-navgo" id="mm-navgo">${ICON.nav}<span>Rota oluştur</span></button>
          <button type="button" class="mm-rcancel" id="mm-rcancel" aria-label="Rotayı iptal et" hidden>${ICON.close}</button>
        </div>
        <p class="mm-dnote" id="mm-dnote" hidden></p>
      </div>
      <div class="mm-panel" id="mm-panel">
        <button type="button" class="mm-start" id="mm-start">${ICON.play}<span>Sürüşü başlat</span></button>
        <div class="mm-ride" id="mm-ride" hidden>
          <div class="mm-spd"><b id="mm-spd">0</b><small id="mm-spdu">km/h</small></div>
          <div class="mm-stats">
            <div><small>Mesafe</small><b id="mm-sd">0 m</b></div>
            <div><small>Süre</small><b id="mm-st">00:00</b></div>
            <button type="button" class="mm-savg" id="mm-savg" aria-label="Ortalama hız türünü değiştir"><small id="mm-savgl">Ort. hareket</small><b id="mm-sa">—</b></button>
            <div><small>Maks.</small><b id="mm-sm">—</b></div>
          </div>
          <div class="mm-rbtns">
            <button type="button" class="mm-rb mm-pause" id="mm-pause" aria-label="Sürüşü duraklat"><span id="mm-pausel">Duraklat</span></button>
            <button type="button" class="mm-rb mm-stop" id="mm-stop" aria-label="Sürüşü bitir"><span>Bitir</span></button>
          </div>
        </div>
      </div>
    </div>
    <div class="mm-modal" id="mm-modal" hidden></div>
  </div>`;

  function mount(host, opts) {
    host.innerHTML = TEMPLATE;
    const $ = id => host.querySelector('#' + id);
    const el = { root: $('mm'), map: $('mm-map'), load: $('mm-load'), loadMsg: $('mm-load-msg'), retry: $('mm-retry'),
      form: $('mm-form'), q: $('mm-q'), go: $('mm-go'), head: $('mm-head'), navbar: $('mm-navbar'), results: $('mm-results'), gps: $('mm-gps'),
      menu: $('mm-menu'), mbtn: $('mm-mbtn'), toast: $('mm-toast'), attr: $('mm-attr'), dest: $('mm-dest'), start: $('mm-start'), ride: $('mm-ride'), modal: $('mm-modal') };

    const S = { cfg: null, map: null, ready: false, active: false, watch: null, me: null, hadFix: false, follow: true,
      meMarker: null, accCircle: null, dest: null, destMarker: null, route: null, routeLines: [], nav: null,
      ride: null, riding: false, trail: null, tick: null, wl: null, hiddenAt: 0, riders: null, toastT: 0, theme: store.get('mm_theme', 'dark'),
      keepAwake: store.get('mm_wake', '1') === '1',
      user: (opts && opts.user) || 'anon', rec: null, trailGroup: null, trailSeg: null, trailBreak: true, sumId: null, persistWarned: false, avgMode: store.get('mm_avg', 'mov'), syncTimer: 0 };

    /* ---------- Yardımcılar ---------- */
    function toast(msg, ms) {
      el.toast.textContent = msg; el.toast.hidden = false;
      clearTimeout(S.toastT); S.toastT = setTimeout(() => { el.toast.hidden = true; }, ms || 4500);
    }
    function chip(text, state) { el.gps.textContent = text; el.gps.dataset.s = state; }
    function setTheme(t) {
      S.theme = t === 'light' ? 'light' : 'dark'; el.root.dataset.theme = S.theme; store.set('mm_theme', S.theme);
      el.menu.querySelectorAll('[data-th]').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.th === S.theme)));
    }
    function measureHead() { const h = el.head.getBoundingClientRect(), r = el.root.getBoundingClientRect(); if (h.height) el.root.style.setProperty('--head', Math.round(h.bottom - r.top) + 'px'); }
    function ll() { return S.me ? [S.me.lat, S.me.lon] : null; }

    /* ---------- Harita ---------- */
    function initMap(cfg) {
      S.cfg = cfg;
      const L = window.L;
      S.map = L.map(el.map, { zoomControl: false, attributionControl: false, worldCopyJump: true, maxZoom: cfg.tileMax || 19 }).setView([39, 35], 5);   // karşılama görünümü (Türkiye); konum işareti değil
      L.tileLayer(cfg.tileUrl, { maxZoom: cfg.tileMax || 19, maxNativeZoom: cfg.tileMax || 19 }).addTo(S.map);
      el.attr.innerHTML = (cfg.tileAttr || '') + (cfg.route && cfg.route.attr ? ' · ' + cfg.route.attr : '');
      S.riders = L.layerGroup().addTo(S.map);
      S.map.on('dragstart', () => { S.follow = false; paintLocate(); });
      el.load.hidden = true;
      S.ready = true;
      paintLocate(); setTheme(S.theme);
      if ('ResizeObserver' in window) new ResizeObserver(() => { S.map && S.map.invalidateSize(); measureHead(); }).observe(el.root);
      measureHead();
      if (S.active) startWatch();
    }
    function paintLocate() { $('mm-loc').classList.toggle('on', S.follow && !!S.me); }

    function meIcon() {
      return window.L.divIcon({ className: 'mm-icon', iconSize: [24, 24], iconAnchor: [12, 12],
        html: '<div class="mm-me"><div class="rot"><i></i></div><b></b></div>' });
    }
    function drawMe(f) {
      const L = window.L, p = [f.lat, f.lon];
      if (!S.meMarker) S.meMarker = L.marker(p, { icon: meIcon(), keyboard: false, interactive: false, zIndexOffset: 1000 }).addTo(S.map);
      else S.meMarker.setLatLng(p);
      const m = S.meMarker.getElement && S.meMarker.getElement();
      if (m) {
        const hd = f.heading != null && f.speed != null && f.speed > 1.5;
        const box = m.querySelector('.mm-me'); if (box) box.classList.toggle('hd', hd);
        const rot = m.querySelector('.rot'); if (rot && hd) rot.style.transform = `rotate(${f.heading}deg)`;
      }
      if (f.acc < 500) {
        if (!S.accCircle) S.accCircle = L.circle(p, { radius: f.acc, weight: 1, color: '#EA8621', fillColor: '#EA8621', fillOpacity: 0.12, interactive: false }).addTo(S.map);
        else { S.accCircle.setLatLng(p); S.accCircle.setRadius(f.acc); }
      }
    }

    /* ---------- GPS ---------- */
    function startWatch() {
      if (S.watch != null || !S.ready) return;
      if (!('geolocation' in navigator)) return chip('Bu cihaz konumu desteklemiyor', 'bad');
      if (window.isSecureContext === false) return chip('Konum için HTTPS gerekli', 'bad');
      chip('GPS aranıyor…', 'warn');
      S.watch = navigator.geolocation.watchPosition(onFix, onGeoErr, { enableHighAccuracy: true, maximumAge: 1000, timeout: 20000 });
    }
    function stopWatch() {
      if (S.watch != null) { try { navigator.geolocation.clearWatch(S.watch); } catch {} S.watch = null; }
    }
    function onGeoErr(e) {
      if (e.code === 1) { chip('Konum izni kapalı', 'bad'); toast('Konum izni verilmedi. Telefon/tarayıcı ayarlarından bu site için konumu aç.', 7000); stopWatch(); }
      else if (e.code === 2) chip('GPS sinyali yok', 'bad');
      else chip('GPS aranıyor…', 'warn');
    }
    function onFix(pos) {
      const c = pos.coords;
      const f = { lat: c.latitude, lon: c.longitude, acc: c.accuracy, t: pos.timestamp || Date.now(),
        speed: c.speed != null && isFinite(c.speed) && c.speed >= 0 ? c.speed : null,
        heading: c.heading != null && isFinite(c.heading) ? c.heading : null };
      S.me = f;
      chip(f.acc <= 20 ? `GPS ±${Math.round(f.acc)} m` : f.acc <= 50 ? `GPS ±${Math.round(f.acc)} m` : `Zayıf sinyal ±${Math.round(f.acc)} m`, f.acc <= 20 ? 'ok' : f.acc <= 50 ? 'warn' : 'bad');
      drawMe(f);
      if (!S.hadFix) { S.hadFix = true; S.follow = true; S.map.setView([f.lat, f.lon], 16); }
      else if (S.follow) S.map.panTo([f.lat, f.lon], { animate: true, duration: 0.6 });
      paintLocate();
      if (rideActive()) { recordFix(f); paintRide(); }
      if (S.nav) updateNav(f);
      if (S.dest && !S.route) $('mm-dline').textContent = destDistText();
    }
    function flyToMe() {
      if (!S.ready) return;
      if (!S.me) { toast(el.gps.dataset.s === 'bad' ? el.gps.textContent + '. Konum alınamadı.' : 'Konum henüz bulunamadı, GPS aranıyor…'); startWatch(); return; }
      S.follow = true; paintLocate();
      S.map.setView([S.me.lat, S.me.lon], Math.max(S.map.getZoom(), 16), { animate: true });
    }

    /* ---------- Diğer sürücüler (altyapı) ---------- */
    function setRiders(list) {
      if (!S.ready) return;
      const L = window.L; S.riders.clearLayers();
      (Array.isArray(list) ? list : []).forEach(r => {
        if (!r || !isFinite(r.lat) || !isFinite(r.lon)) return;
        const name = String(r.name || '?'), init = esc(name.trim().charAt(0).toUpperCase() || '?');
        const mk = L.marker([r.lat, r.lon], { keyboard: false, icon: L.divIcon({ className: 'mm-icon', iconSize: [34, 34], iconAnchor: [17, 17],
          html: `<div class="mm-rider${r.leader ? ' lead' : ''}"><span>${init}</span></div>` }) });
        const sp = kmh(r.speed);
        mk.bindTooltip(esc(name) + (sp != null ? ' · ' + Math.round(sp) + ' km/h' : ''), { direction: 'top', offset: [0, -16] });
        S.riders.addLayer(mk);
      });
    }

    /* ---------- Arama ---------- */
    function showResults(html) { el.results.innerHTML = html; el.results.hidden = !html; if (html) el.toast.hidden = true; }
    el.form.addEventListener('submit', async e => {
      e.preventDefault();
      const q = el.q.value.trim();
      if (!S.ready) return toast('Harita henüz hazır değil.');
      if (q.length < 3) return toast('En az 3 karakter yaz.');
      el.go.disabled = true; el.go.textContent = '…';
      showResults('<div class="mm-rmsg">Aranıyor…</div>');
      try {
        const p = new URLSearchParams({ q });
        if (S.me) { p.set('lat', S.me.lat.toFixed(4)); p.set('lon', S.me.lon.toFixed(4)); }
        const r = await fetch('/api/geocode?' + p, { credentials: 'same-origin' });
        const j = await r.json().catch(() => ({}));
        if (r.status === 401) throw new Error('Oturum süresi dolmuş. Sayfayı yenile.');
        if (!r.ok) throw new Error(j.error || 'Arama başarısız.');
        const list = j.results || [];
        if (!list.length) return showResults('<div class="mm-rmsg">Sonuç bulunamadı. Daha açık yazmayı dene.</div>');
        showResults(list.map((x, i) => `<button type="button" class="mm-ritem" data-i="${i}"><b>${esc(x.title)}${S.me ? `<em>${fmtDist(haversine(S.me.lat, S.me.lon, x.lat, x.lon))}</em>` : ''}</b><span>${esc(x.subtitle)}</span></button>`).join(''));
        el.results._list = list;
      } catch (err) { showResults(`<div class="mm-rmsg err">${esc(err.message || 'Arama başarısız.')}</div>`); }
      finally { el.go.disabled = false; el.go.textContent = 'Ara'; }
    });
    el.results.addEventListener('click', e => {
      const b = e.target.closest('.mm-ritem'); if (!b) return;
      const x = (el.results._list || [])[Number(b.dataset.i)]; if (!x) return;
      showResults(''); el.q.blur(); setDest(x);
    });
    el.q.addEventListener('keydown', e => { if (e.key === 'Escape') { showResults(''); el.q.blur(); } });

    /* ---------- Hedef, rota ve navigasyon ----------
       Akış: hedef seç (API çağrısı YOK) → "Rota oluştur" (1 çağrı) → önizleme (mesafe, süre, varış) → "Navigasyonu başlat" (çağrı YOK)
       → konum değiştikçe kalan mesafe/süre yerelde hesaplanır; yalnızca rotadan sapınca (ve sınırlı sıklıkta) yeni rota istenir. */
    const AVOID_TXT = { highways: 'Otoyoldan kaçın', tolls: 'Ücretli yoldan kaçın', ferries: 'Feribotsuz' };
    const rcfg = () => (S.cfg && S.cfg.route) || null;
    const routingOn = () => !!(S.cfg && S.cfg.routing && rcfg());
    const hhmm = sec => new Date(Date.now() + sec * 1000).toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
    Object.assign(S, { avoid: new Set((store.get('mm_avoid', '') || '').split(',').filter(Boolean)), route: null, routeLines: [], routeBusy: false, routeMsg: '', routeTimer: 0, reqId: 0, lastReq: { key: '', t: 0 } });

    function setDest(x) {
      dropRoute();
      S.dest = { lat: x.lat, lon: x.lon, title: x.title, subtitle: x.subtitle };
      if (S.destMarker) S.destMarker.remove();
      S.destMarker = window.L.marker([x.lat, x.lon], { keyboard: false, icon: window.L.divIcon({ className: 'mm-icon', iconSize: [32, 40], iconAnchor: [16, 38], html: PIN }) }).addTo(S.map);
      S.follow = false; paintLocate();
      el.dest.hidden = false; paintDest();
      const pad = { paddingTopLeft: [40, 110], paddingBottomRight: [70, 260], maxZoom: 16 };
      if (S.me) S.map.fitBounds([[S.me.lat, S.me.lon], [x.lat, x.lon]], pad); else S.map.setView([x.lat, x.lon], 14);
    }
    function clearDest() {
      dropRoute();
      if (S.destMarker) { S.destMarker.remove(); S.destMarker = null; }
      S.dest = null; el.dest.hidden = true;
    }
    function destDistText() { return S.me && S.dest ? 'Kuş uçuşu: ' + fmtDist(haversine(S.me.lat, S.me.lon, S.dest.lat, S.dest.lon)) + ' (yol mesafesi değildir)' : 'Mesafe için konumun bekleniyor…'; }
    function paintDest() {
      const d = S.dest, r = S.route; if (!d) return;
      const on = routingOn(), opts = on ? (rcfg().avoid || []) : [];
      $('mm-dtitle').textContent = d.title || 'Seçilen konum';
      $('mm-dsub').textContent = d.subtitle || ''; $('mm-dsub').hidden = !!r;
      $('mm-dline').hidden = !!r; $('mm-dline').textContent = destDistText();
      $('mm-rinfo').hidden = !r;
      if (r) {
        $('mm-rdist').textContent = fmtDist(r.distance);
        $('mm-reta').textContent = '≈ ' + fmtEta(r.duration) + ' · Varış ' + hhmm(r.duration);
        $('mm-rlabel').textContent = r.label + (r.toll === true ? ' · ücretli yol içerir' : '') + (r.ferry === true ? ' · feribot içerir' : '') + ' · trafiksiz tahmin';
      }
      const ch = $('mm-chips'); ch.hidden = !opts.length;
      ch.innerHTML = opts.map(o => `<button type="button" class="mm-chip2" data-av="${o}" aria-pressed="${S.avoid.has(o)}">${AVOID_TXT[o] || o}</button>`).join('');
      const go = $('mm-navgo'); go.disabled = !on || S.routeBusy;
      go.querySelector('span').textContent = S.routeBusy ? 'Rota hesaplanıyor…' : r ? 'Navigasyonu başlat' : 'Rota oluştur';
      $('mm-rcancel').hidden = !r;
      const note = $('mm-dnote');
      note.hidden = on && !S.routeMsg;
      note.classList.toggle('err', !!S.routeMsg);
      note.textContent = S.routeMsg || (on ? '' : 'Rota hesaplama bu sunucuda henüz etkin değil; şimdilik yalnızca hedef gösterilir.');
    }

    function clearRouteLayers() { S.routeLines.forEach(l => l.remove()); S.routeLines = []; }
    function drawRoute(coords) {
      clearRouteLayers();
      const L = window.L;
      S.routeLines = [L.polyline(coords, { color: '#031420', weight: 12, opacity: 0.8, lineCap: 'round', interactive: false }).addTo(S.map),
                      L.polyline(coords, { color: '#EA8621', weight: 7, opacity: 1, lineCap: 'round', interactive: false }).addTo(S.map)];
    }
    // Rotayı, navigasyonu ve bekleyen istekleri bırak (hedef kalır)
    function dropRoute() {
      clearTimeout(S.routeTimer); S.reqId++; S.routeBusy = false; S.routeMsg = '';
      clearRouteLayers(); S.route = null;
      if (S.nav) { S.nav = null; el.navbar.hidden = true; }
      $('mm-form').hidden = false; measureHead();
      if (!S.active && !rideActive()) stopWatch();
    }

    // Tek yetkili rota isteği: gereksiz çağrıları burada engelliyoruz
    async function requestRoute(auto, from) {
      if (!routingOn() || !S.dest) return null;
      from = from || S.me;
      if (!from) { if (!auto) throw new Error('Önce konumun bulunmalı. GPS bekleniyor…'); return null; }
      if (navigator.onLine === false) { if (!auto) throw new Error('Çevrimdışısın; rota hesaplanamıyor.'); return null; }
      const avoid = (rcfg().avoid || []).filter(x => S.avoid.has(x));
      const key = [from.lat.toFixed(4), from.lon.toFixed(4), S.dest.lat.toFixed(4), S.dest.lon.toFixed(4), avoid.join(',')].join('|');
      if (!auto && S.route && S.lastReq.key === key && Date.now() - S.lastReq.t < 30000) return S.route;   // aynı istek 30 sn içinde: yeniden sorma
      if (S.routeBusy) return null;
      const id = ++S.reqId, dest = S.dest; S.routeBusy = true; S.routeMsg = ''; if (!auto) paintDest();
      try {
        const p = new URLSearchParams({ from: from.lat.toFixed(6) + ',' + from.lon.toFixed(6), to: dest.lat.toFixed(6) + ',' + dest.lon.toFixed(6) });
        if (avoid.length) p.set('avoid', avoid.join(','));
        const r = await fetch('/api/route?' + p, { credentials: 'same-origin' });
        const j = await r.json().catch(() => ({}));
        if (id !== S.reqId || S.dest !== dest) return null;           // bu arada hedef değişti / rota iptal edildi: yanıtı yok say
        if (r.status === 503) { S.cfg.routing = false; throw new Error('Rota servisi bu sunucuda etkin değil.'); }
        if (r.status === 401) throw new Error('Oturum süresi dolmuş. Sayfayı yenile.');
        if (!r.ok || !Array.isArray(j.coords) || j.coords.length < 2) throw new Error(j.error || 'Rota alınamadı.');
        S.lastReq = { key, t: Date.now() };
        S.route = { provider: j.provider, profile: j.profile, label: j.label, distance: j.distance, duration: j.duration, toll: j.toll, ferry: j.ferry,
          avoid: j.avoid || [], coords: j.coords, tracker: new RouteTracker(j.coords, j.duration, j.distance) };
        drawRoute(j.coords);
        return S.route;
      } finally { if (id === S.reqId) S.routeBusy = false; }
    }
    async function previewRoute() {
      try {
        const r = await requestRoute(false);
        if (r) S.map.fitBounds(r.coords, { paddingTopLeft: [40, 110], paddingBottomRight: [70, 300], maxZoom: 17 });
      } catch (err) { S.routeMsg = err.message || 'Rota alınamadı.'; clearRouteLayers(); S.route = null; }
      paintDest();
    }
    $('mm-navgo').addEventListener('click', async () => {
      if (!S.dest || !routingOn() || S.routeBusy) return;
      if (!S.route) return previewRoute();
      // Önizlemeden bu yana rotadan uzaklaştıysa başlamadan önce yeni rota al
      const pr = S.me && S.route.tracker.progress(S.me.lat, S.me.lon);
      if (pr && pr.off > 150) { S.route = null; await previewRoute(); if (!S.route) return; }
      startNav();
    });
    $('mm-rcancel').addEventListener('click', () => { dropRoute(); paintDest(); });
    $('mm-dclear').addEventListener('click', clearDest);
    $('mm-chips').addEventListener('click', e => {
      const b = e.target.closest('[data-av]'); if (!b) return;
      const id = b.dataset.av; if (S.avoid.has(id)) S.avoid.delete(id); else S.avoid.add(id);
      store.set('mm_avoid', [...S.avoid].join(',')); paintDest();
      if (S.route) { clearTimeout(S.routeTimer); S.routeTimer = setTimeout(previewRoute, 700); }   // art arda dokunuşlar tek istek olur; nihai tercih aynıysa hiç istek atılmaz
    });

    function setNote(t) { $('mm-navnote').textContent = t || (S.route ? S.route.label : ''); }
    function startNav() {
      const r = S.route; if (!r || S.nav) return;
      S.nav = { offSince: 0, lastReroute: Date.now(), backoff: 30000, reroutes: 0, busy: false, prev: null, movedM: 0, movingS: 0 };
      el.dest.hidden = true; el.navbar.hidden = false; $('mm-form').hidden = true;
      $('mm-navto').textContent = S.dest.title || 'Hedef'; setNote('');
      S.follow = true; paintLocate();
      if (S.me) S.map.setView([S.me.lat, S.me.lon], Math.max(S.map.getZoom(), 16));
      startWatch(); measureHead();
      if (S.me) updateNav(S.me);
    }
    function updateNav(f) {
      const n = S.nav, r = S.route; if (!n || !r) return;
      if (f.acc <= 50) {                                               // gerçek hareket hızını ETA için biriktir
        if (n.prev) {
          const dt = (f.t - n.prev.t) / 1000;
          if (dt > 0 && dt <= 30) { const d = haversine(n.prev.lat, n.prev.lon, f.lat, f.lon), sp = f.speed != null ? f.speed : d / dt; if (sp >= 1) { n.movedM += d; n.movingS += dt; } }
        }
        n.prev = f;
      }
      const p = r.tracker.progress(f.lat, f.lon);
      const eta = estimateEta({ remaining: p.remaining, planDist: r.distance, planDur: r.duration, movedM: n.movedM, movingS: n.movingS });
      $('mm-navrem').textContent = fmtDist(p.remaining);
      $('mm-naveta').textContent = '≈ ' + fmtEta(eta) + ' · Varış ' + hhmm(eta);
      if (p.remaining < Math.max(40, f.acc * 1.5) && r.distance > 100) { toast('Hedefe ulaştın.', 6000); return clearDest(); }
      if (f.acc > 50) return;                                          // zayıf konumla sapma kararı verme
      const now = Date.now();
      if (p.off > Math.max(80, f.acc * 2)) {
        n.offSince = n.offSince || now;
        if (navigator.onLine === false) setNote('Çevrimdışı: rota güncellenemiyor, eski rota gösteriliyor.');
        else if (!n.busy && now - n.offSince > 10000 && now - n.lastReroute > n.backoff && n.reroutes < 12) reroute(f);
      } else { n.offSince = 0; if (!n.busy) setNote(''); }
    }
    // Rotadan çıkınca: en geç 30 sn'de bir (hata olursa üstel bekleme), oturum başına en çok 12 kez
    async function reroute(f) {
      const n = S.nav; if (!n || !S.dest) return;
      n.busy = true; n.lastReroute = Date.now(); n.reroutes++; setNote('Rotadan çıktın · yeni rota hesaplanıyor…');
      try {
        const route = await requestRoute(true, f);
        if (S.nav === n) { if (route) { n.offSince = 0; n.backoff = 30000; setNote(''); } else { n.backoff = Math.min(n.backoff * 2, 300000); setNote('Rota yenilenemedi · eski rota gösteriliyor.'); } }
      } catch { if (S.nav === n) { n.backoff = Math.min(n.backoff * 2, 300000); setNote('Rota yenilenemedi · eski rota gösteriliyor.'); } }
      finally { if (S.nav === n) n.busy = false; }
    }
    $('mm-navstop').addEventListener('click', () => { dropRoute(); if (S.dest) { el.dest.hidden = false; paintDest(); } });   // Bitir: rota silinir, hedef kalır
    $('mm-newdest').addEventListener('click', () => {                                                                           // Yeni hedef: rotayı bozmadan arama kutusunu aç
      const f = $('mm-form'); f.hidden = !f.hidden; measureHead(); if (!f.hidden) el.q.focus();
    });

    /* ---------- Sürüş kaydı: ölçüm = ride-core.js (Recorder), cihazda saklama + eşitleme = ride-store.js ---------- */
    const RC = () => window.RideCore, RS = () => window.RideStore;
    function rideOpen() { return !!S.rec && (S.rec.status === 'active' || S.rec.status === 'paused'); }
    function rideActive() { return !!S.rec && S.rec.status === 'active'; }
    async function acquireWake() {
      if (!S.keepAwake || !('wakeLock' in navigator) || S.wl || !rideActive()) return;
      try { S.wl = await navigator.wakeLock.request('screen'); S.wl.addEventListener('release', () => { S.wl = null; }); } catch {}
    }
    function releaseWake() { try { S.wl && S.wl.release(); } catch {} S.wl = null; }

    // Cihaza yazılamazsa bir kez uyar; sürüş bellekte ve ekranda sürer
    function persistFail() { if (S.persistWarned) return; S.persistWarned = true; toast('Sürüş cihaza yazılamadı; sayfayı kapatırsan veri kaybolabilir.', 8000); }
    function metaOf(r) {
      const ended = r.status === 'ended', now = Date.now();
      return { id: r.id, owner: S.user, status: r.status, startedAt: r.startedAt, endedAt: r.endedAt, events: r.events.slice(),
        fixCount: r.fixes.length, sync: ended ? 'pending' : 'local', summary: r.summary(ended ? r.endedAt : now), updatedAt: now };
    }
    const persistMeta = r => RS().saveMeta(metaOf(r || S.rec)).catch(persistFail);

    /* iz çizgisi: boşluk/duraklatma sonrası yeni parça başlar (aradaki düz çizgi çizilmez) */
    function newTrail() { clearTrail(); S.trailGroup = window.L.layerGroup().addTo(S.map); S.trailBreak = true; S.trailSeg = null; }
    function clearTrail() { if (S.trailGroup) { S.trailGroup.clearLayers(); S.trailGroup.remove(); } S.trailGroup = null; S.trailSeg = null; }
    function trailAdd(lat, lon, brk) {
      if (!S.trailGroup) return;
      if (brk || S.trailBreak || !S.trailSeg) {
        S.trailSeg = window.L.polyline([[lat, lon]], { color: '#F2A64E', weight: 4, opacity: 0.9, interactive: false });
        S.trailGroup.addLayer(S.trailSeg); S.trailBreak = false;
      } else S.trailSeg.addLatLng([lat, lon]);
    }
    function recordFix(f) {
      const rec = S.rec.addFix(f);
      if (S.rec.limitReached && !S.limitToast) { S.limitToast = true; toast('Kayıt sınırına ulaşıldı (≈8 saat). Sürüşü bitirip yenisini başlat.', 9000); }
      if (!rec) return null;
      RS().addFix(S.rec.id, rec[0], rec).catch(persistFail);          // anahtar = zaman damgası: çakışmaz, sıralı okunur
      if (rec[5] === 0 || rec[5] === 3) trailAdd(rec[1], rec[2], rec[5] === 3);
      return rec;
    }

    function showRidePanel() {
      el.start.hidden = true; el.ride.hidden = false;
      if (!S.tick) S.tick = setInterval(paintRide, 1000);
      acquireWake(); startWatch(); paintRide();
    }
    function startRide() {
      if (rideOpen() || !S.ready) return !S.ready && toast('Harita henüz hazır değil.');
      if (!RS().persistent && !S.memWarned) { S.memWarned = true; toast('Bu tarayıcı kalıcı kayıt vermiyor: sürüş yalnızca sayfa açıkken saklanır.', 8000); }
      S.rec = new (RC().Recorder)(); S.limitToast = false;
      S.rec.start(Date.now());
      newTrail(); persistMeta();
      if (S.me && Date.now() - S.me.t < 5000) recordFix(S.me);       // GPS tazeyse ilk noktayı hemen al
      S.follow = true; paintLocate();
      if (S.me) S.map.setView([S.me.lat, S.me.lon], Math.max(S.map.getZoom(), 16));
      showRidePanel();
      if (el.gps.dataset.s === 'bad') toast('GPS sinyali zayıf ya da yok; konum geldikçe kayıt başlar.');
    }
    function pauseRide() {
      if (!rideActive()) return;
      S.rec.pause(Date.now()); S.trailBreak = true; persistMeta(); releaseWake(); paintRide();
      if (!S.active && !S.nav) stopWatch();
    }
    function resumeRide() {
      if (!S.rec || S.rec.status !== 'paused') return;
      S.rec.resume(Date.now()); S.trailBreak = true; persistMeta();
      S.follow = true; paintLocate(); startWatch(); acquireWake(); paintRide();
    }
    function paintRide() {
      const r = S.rec; if (!r) return;
      const now = Date.now(), sm = r.summary(now), paused = r.status === 'paused';
      const fresh = !paused && r.speed != null && now - r.speedAt < 6000;
      $('mm-spd').textContent = fresh ? String(Math.round(kmh(r.speed))) : '—';
      $('mm-spdu').textContent = paused ? 'duraklatıldı' : 'km/h';
      el.ride.classList.toggle('paused', paused);
      $('mm-sd').textContent = fmtDist(sm.distM);
      $('mm-st').textContent = fmtClock(sm.durationS);
      const mov = S.avgMode === 'mov', a = mov ? sm.avgMovingKmh : sm.avgTotalKmh;
      $('mm-savgl').textContent = mov ? 'Ort. hareket' : 'Ort. toplam';
      $('mm-sa').textContent = a == null ? '—' : Math.round(a) + ' km/h';
      $('mm-sm').textContent = sm.maxKmh == null ? '—' : Math.round(sm.maxKmh) + ' km/h';
      $('mm-pausel').textContent = paused ? 'Devam' : 'Duraklat';
      $('mm-pause').classList.toggle('resume', paused);
      $('mm-pause').setAttribute('aria-label', paused ? 'Sürüşe devam et' : 'Sürüşü duraklat');
    }
    $('mm-savg').addEventListener('click', () => { S.avgMode = S.avgMode === 'mov' ? 'tot' : 'mov'; store.set('mm_avg', S.avgMode); paintRide(); });
    $('mm-pause').addEventListener('click', () => (S.rec && S.rec.status === 'paused' ? resumeRide() : pauseRide()));
    el.start.addEventListener('click', startRide);

    function modal(html) { el.modal.innerHTML = '<div class="mm-mcard" role="dialog" aria-modal="true">' + html + '</div>'; el.modal.hidden = false; const b = el.modal.querySelector('[data-focus]'); if (b) b.focus(); }
    function closeModal() { el.modal.hidden = true; el.modal.innerHTML = ''; }
    function closeSummary() { closeModal(); clearTrail(); S.sumId = null; }
    $('mm-stop').addEventListener('click', () => {
      if (!rideOpen()) return;
      modal('<h3>Sürüş bitirilsin mi?</h3><p>Sürüş cihaza kaydedilir ve özeti gösterilir.</p><div class="mm-mbtns"><button type="button" class="mm-mb" data-act="cancel">Devam et</button><button type="button" class="mm-mb danger" data-act="end" data-focus>Bitir</button></div>');
    });
    el.modal.addEventListener('click', e => {
      const a = e.target.closest('[data-act]'); if (!a) return;
      const k = a.dataset.act;
      if (k === 'cancel') closeModal();
      else if (k === 'close') closeSummary();
      else if (k === 'end') endRide();
      else if (k === 'rec-end') endRide(S.recLastT);
      else if (k === 'rec-resume') { closeModal(); resumeRide(); }
    });

    const SYNC_TXT = { sending: 'Sunucuya gönderiliyor…', synced: 'Sunucuya kaydedildi ✓', offline: 'Çevrimdışı: sürüş cihazda güvende, bağlantı gelince otomatik gönderilecek.',
      auth: 'Oturum süresi dolmuş: giriş yapınca otomatik gönderilecek.', retry: 'Sunucu şu an yanıt vermiyor; otomatik tekrar denenecek.' };
    const savedLine = () => RS().persistent ? 'Cihaza kaydedildi ✓' : 'Bu tarayıcı kalıcı kayıt vermiyor';
    function onSyncState(id, state, msg) {
      if (id !== S.sumId) return;
      const p = host.querySelector('#mm-syncst'); if (!p) return;
      p.textContent = savedLine() + ' · ' + (state === 'failed' ? 'Sunucu sürüşü kabul etmedi: ' + (msg || '') + ' (veri cihazda saklanıyor)' : SYNC_TXT[state] || '');
      p.dataset.s = state;
    }
    function syncNow() { return RS().sync(S.user, onSyncState).then(r => { refreshCounts(); return r; }).catch(() => {}); }
    async function refreshCounts() {
      try {
        const c = await RS().counts(S.user), bad = c.pending + c.failed;
        $('mm-savedtxt').textContent = 'Kayıtlı sürüş: ' + c.total + (bad ? ' · gönderilmeyi bekleyen: ' + bad : '');
        $('mm-syncbtn').hidden = !bad;
        const h = $('mm-synchint'), msgs = [];
        if (c.failed) msgs.push(c.failed + ' sürüş sunucu tarafından kabul edilmedi; cihazda saklanıyor.');
        if (!RS().persistent) msgs.push('Bu tarayıcı cihaz kaydı vermiyor.');
        h.hidden = !msgs.length; h.textContent = msgs.join(' ');
      } catch {}
    }
    $('mm-syncbtn').addEventListener('click', async () => { await RS().retryFailed(S.user); toast('Eşitleniyor…', 2500); const r = await syncNow(); if (r && r.offline) toast('Çevrimdışısın; bağlantı gelince otomatik gönderilecek.', 5000); });
    window.addEventListener('online', () => syncNow());
    S.syncTimer = setInterval(() => { if (document.body.contains(host)) syncNow(); }, 60000);

    const dur = s => fmtClock(s);
    function showSummary(sm, id, mode) {
      if (mode === 'empty') {
        return modal('<h3>Sürüş özeti</h3><p>Hiç geçerli konum alınamadığı için kaydedilecek sürüş verisi yok; bu sürüş kaydedilmedi. Konum iznini ve GPS sinyalini kontrol et.</p><div class="mm-mbtns"><button type="button" class="mm-mb primary" data-act="close" data-focus>Tamam</button></div>');
      }
      const row = (k, v) => `<div><small>${k}</small><b>${v}</b></div>`, kh = v => (v == null ? '—' : Math.round(v) + ' km/h');
      const notes = [];
      if (sm.rejectedAcc || sm.rejectedJump) notes.push(`Elenen konum: ${sm.rejectedAcc} zayıf doğruluk, ${sm.rejectedJump} GPS sıçraması.`);
      if (sm.gaps || sm.reanchors) notes.push(`Konum alınamayan ${sm.gaps + sm.reanchors} kesinti oldu; o aralıklardaki mesafe ölçülmedi.`);
      if (sm.limitReached) notes.push('Kayıt sınırına ulaşıldı; sonrası kaydedilmedi.');
      modal('<h3>Sürüş özeti</h3><div class="mm-sum">' +
        row('Mesafe', fmtDist(sm.distM)) + row('Aktif süre', dur(sm.durationS)) + row('Hareket süresi', dur(sm.movingS)) + row('Duruş süresi', dur(sm.stoppedS)) +
        row('Ort. hız (hareket)', kh(sm.avgMovingKmh)) + row('Ort. hız (toplam)', kh(sm.avgTotalKmh)) + row('Maks. hız', kh(sm.maxKmh)) +
        row('Duraklatma', sm.pausedS >= 1 ? sm.pauseCount + ' × ' + dur(sm.pausedS) : '—') + row('Rota noktası', sm.points) + '</div>' +
        notes.map(n => `<p class="warn">${esc(n)}</p>`).join('') +
        '<p>Mesafe ve hızlar telefonun GPS ölçümlerinden hesaplanır. Aktif süre duraklatmaları içermez; ortalama hız ikisine göre de verilir.</p>' +
        `<p class="mm-sync" id="mm-syncst" data-s="local">${savedLine()}</p>` +
        '<div class="mm-mbtns"><button type="button" class="mm-mb primary" data-act="close" data-focus>Tamam</button></div>');
    }
    function endRide(at) {
      const r = S.rec; if (!rideOpen()) return;
      clearInterval(S.tick); S.tick = null; releaseWake();
      r.end(at || Date.now());
      const sm = r.summary(r.endedAt), id = r.id, hasData = r.track.length > 0;
      S.rec = null; el.ride.hidden = true; el.start.hidden = false;
      if (!S.active && !S.nav) stopWatch();
      if (r.track.length > 1) S.map.fitBounds(r.track, { paddingTopLeft: [40, 100], paddingBottomRight: [40, 330], maxZoom: 17 });
      S.follow = false; paintLocate(); S.sumId = id;
      if (!hasData) { RS().remove(id).catch(() => {}); showSummary(sm, id, 'empty'); S.sumId = null; refreshCounts(); return; }
      showSummary(sm, id, 'saved');
      RS().saveMeta(metaOf(r)).then(() => syncNow(), persistFail);   // önce cihaza yaz, sonra gönder
    }
    // Sayfa kapandı/yenilendiyse yarım kalan sürüşü cihazdan kurtar
    async function checkRecovery() {
      if (rideOpen()) return;
      const open = await RS().findOpen(S.user); if (!open.length) return;
      const lastAct = d => Math.max(d.startedAt, ...d.events.map(e => e[0]), ...(d.fixes.length ? [d.fixes[d.fixes.length - 1][0]] : []));
      for (const m of open.slice(1)) {                                  // olmaması gereken eski açık kayıtlar: son bilinen anda kapat
        const l = await RS().load(m.id); if (!l) continue;
        const r = RC().Recorder.replay(l.data), t = lastAct(l.data);
        if (r.status === 'active') r.pause(t); r.end(t);
        if (r.track.length) await RS().saveMeta(metaOf(r)); else await RS().remove(m.id);
      }
      const l = await RS().load(open[0].id); if (!l) return;
      const rec = RC().Recorder.replay(l.data), t = lastAct(l.data);
      if (rec.status === 'active') rec.pause(t);                         // kopma anında duraklatılmış say
      S.rec = rec; S.recLastT = t; S.limitToast = false;
      newTrail(); rec.track.forEach((p, i) => trailAdd(p[0], p[1], i === 0));
      persistMeta(); showRidePanel();
      if (rec.track.length > 1) S.map.fitBounds(rec.track, { paddingTopLeft: [40, 100], paddingBottomRight: [40, 330], maxZoom: 17 });
      const sm = rec.summary(t), when = new Date(rec.startedAt).toLocaleString('tr-TR', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
      modal('<h3>Yarım kalan sürüş</h3><p>' + esc(when) + ' tarihli sürüş sayfa kapanınca/yenilenince yarıda kalmış. Cihazda saklanan ' + sm.points + ' GPS noktası, ' + fmtDist(sm.distM) + ' korundu. Sürüş son kayıt anında duraklatıldı.</p>' +
        '<div class="mm-mbtns"><button type="button" class="mm-mb" data-act="rec-end">Bitir ve kaydet</button><button type="button" class="mm-mb primary" data-act="rec-resume" data-focus>Devam et</button></div>');
    }
    document.addEventListener('visibilitychange', () => {
      if (!rideActive()) return;
      if (document.hidden) S.hiddenAt = Date.now();
      else {
        if (S.hiddenAt && Date.now() - S.hiddenAt > 5000) toast('Uygulama arka plandaydı; bu sürede konum kaydı olmayabilir.', 6000);
        S.hiddenAt = 0; acquireWake();
      }
    });

    /* ---------- Kontroller ---------- */
    $('mm-zin').addEventListener('click', () => S.ready && S.map.zoomIn());
    $('mm-zout').addEventListener('click', () => S.ready && S.map.zoomOut());
    $('mm-loc').addEventListener('click', flyToMe);
    el.mbtn.addEventListener('click', e => { e.stopPropagation(); const o = el.menu.hidden; el.menu.hidden = !o; el.mbtn.setAttribute('aria-expanded', String(o)); });
    el.menu.addEventListener('click', e => { e.stopPropagation(); const t = e.target.closest('[data-th]'); if (t) setTheme(t.dataset.th); });
    $('mm-wake').checked = S.keepAwake;
    $('mm-wake').addEventListener('change', e => { S.keepAwake = e.target.checked; store.set('mm_wake', S.keepAwake ? '1' : '0'); if (rideActive()) (S.keepAwake ? acquireWake() : releaseWake()); });
    if (!('wakeLock' in navigator)) { $('mm-wake').disabled = true; $('mm-wake').checked = false; $('mm-wakenote').textContent = 'Bu tarayıcı ekranı açık tutmayı desteklemiyor. Sürüş boyunca ekranı kendin açık tut; ekran kilitlenirse konum alınamayabilir.'; }
    host.addEventListener('click', e => { if (!el.menu.hidden && !el.menu.contains(e.target)) { el.menu.hidden = true; el.mbtn.setAttribute('aria-expanded', 'false'); } if (!el.results.hidden && !el.head.contains(e.target) && !el.results.contains(e.target)) showResults(''); });
    host.addEventListener('keydown', e => { if (e.key === 'Escape') { el.menu.hidden = true; if (!el.modal.hidden && el.modal.querySelector('[data-act=close]')) closeSummary(); } });
    setTheme(S.theme);

    /* ---------- Başlatma ---------- */
    function boot() {
      el.load.hidden = false; el.retry.hidden = true; el.loadMsg.textContent = 'Harita yükleniyor…';
      const cfgP = fetch('/api/maps/config', { credentials: 'same-origin' }).then(r => { if (!r.ok) throw new Error(r.status === 401 ? 'Oturum süresi dolmuş. Sayfayı yenile.' : 'Harita ayarları alınamadı.'); return r.json(); });
      const ridesP = loadScripts(['/ride-core.js', '/ride-store.js']).then(() => window.RideStore.init());
      Promise.all([cfgP, loadLeaflet(), ridesP]).then(([cfg]) => { initMap(cfg); checkRecovery().catch(() => {}); refreshCounts(); syncNow(); }).catch(err => {
        el.loadMsg.textContent = err.message || 'Harita yüklenemedi.'; el.retry.hidden = false;
      });
    }
    el.retry.addEventListener('click', boot);
    boot();

    return {
      activate() { S.active = true; if (S.ready) { S.map.invalidateSize(); measureHead(); startWatch(); } },
      deactivate() { S.active = false; if (!rideActive() && !S.nav) stopWatch(); },
      setRiders, flyToMe
    };
  }

  window.MotoMap = { mount, _core: Core };
})();
