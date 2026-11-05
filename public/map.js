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

  const MOVE_MS = 0.8;   // bu hızın (m/sn ≈ 2,9 km/h) altı "duruyor" sayılır; GPS titremesi mesafeye eklenmez
  class RideStats {
    constructor(now) { this.t0 = now; this.dist = 0; this.moveS = 0; this.max = 0; this.gaps = 0; this.last = null; this.anchor = null; this.speed = null; this.speedAt = 0; this.points = []; }
    // f: { lat, lon, acc, speed (m/sn | null), t (ms) } — zayıf (±50 m üstü) konumlar tamamen yok sayılır.
    // Cihaz hız veriyorsa onunla, vermiyorsa "çapa" yöntemiyle (konum, ölçüm hatasından fazla uzaklaşınca) hareket sayılır; GPS titremesi mesafeye eklenmez.
    add(f) {
      if (!(f.acc <= 50)) return false;
      const p = this.last;
      let disp = f.speed;                                   // ekranda gösterilecek hız (m/sn)
      if (!p) this.anchor = { lat: f.lat, lon: f.lon, t: f.t };
      else {
        const dt = (f.t - p.t) / 1000;
        if (dt <= 0) return false;
        const d = haversine(p.lat, p.lon, f.lat, f.lon);
        if (dt > 30 && d > 100) {                           // uzun boşluk + büyük sıçrama: arada ölçüm yok, mesafe eklenmez
          this.gaps++; this.anchor = { lat: f.lat, lon: f.lon, t: f.t };
        } else if (f.speed != null) {
          if (f.speed >= MOVE_MS) { this.dist += d; this.moveS += Math.min(dt, 30); this.anchor = { lat: f.lat, lon: f.lon, t: f.t }; }
          else disp = 0;
        } else {
          const a = this.anchor, da = haversine(a.lat, a.lon, f.lat, f.lon), dta = Math.max(0.001, (f.t - a.t) / 1000);
          if (da > Math.max(f.acc, 6)) { this.dist += da; this.moveS += Math.min(dta, 30); disp = da / dta; this.anchor = { lat: f.lat, lon: f.lon, t: f.t }; }
          else disp = 0;
        }
      }
      this.speed = disp == null ? null : disp;
      this.speedAt = f.t;
      if (this.speed != null && f.acc <= 30 && this.speed <= 83) this.max = Math.max(this.max, this.speed);   // 83 m/sn ≈ 300 km/h üstü hatalı ölçüm
      if (this.points.length < 20000) this.points.push([f.lat, f.lon]);
      this.last = { lat: f.lat, lon: f.lon, acc: f.acc, t: f.t };
      return true;
    }
    summary(now) {
      return { dist: this.dist, elapsedS: (now - this.t0) / 1000, moveS: this.moveS, gaps: this.gaps,
        avgKmh: this.moveS >= 10 ? this.dist / this.moveS * 3.6 : null, maxKmh: this.max > 0 ? this.max * 3.6 : null };
    }
  }

  class RouteTracker {
    constructor(coords, duration) {
      this.c = coords; this.dur = duration; this.cum = [0];
      for (let i = 1; i < coords.length; i++) this.cum.push(this.cum[i - 1] + haversine(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]));
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
    eta(remaining) { return this.total > 0 ? this.dur * remaining / this.total : 0; }
  }

  const Core = { haversine, fmtDist, fmtClock, fmtEta, RideStats, RouteTracker };
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
            <div class="mm-navnote" id="mm-navnote">Araç rotası · motosiklet için optimize değil</div>
          </div>
          <button type="button" class="mm-navstop" id="mm-navstop">Durdur</button>
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
        <button type="button" class="mm-navgo" id="mm-navgo">${ICON.nav}<span>Navigasyonu başlat</span></button>
        <p class="mm-dnote" id="mm-dnote" hidden></p>
      </div>
      <div class="mm-panel" id="mm-panel">
        <button type="button" class="mm-start" id="mm-start">${ICON.play}<span>Sürüşü başlat</span></button>
        <div class="mm-ride" id="mm-ride" hidden>
          <div class="mm-spd"><b id="mm-spd">0</b><small>km/h</small></div>
          <div class="mm-stats">
            <div><small>Mesafe</small><b id="mm-sd">0 m</b></div>
            <div><small>Süre</small><b id="mm-st">00:00</b></div>
            <div><small>Ort.</small><b id="mm-sa">—</b></div>
            <div><small>Maks.</small><b id="mm-sm">—</b></div>
          </div>
          <button type="button" class="mm-stop" id="mm-stop" aria-label="Sürüşü bitir">${ICON.stop}<span>Bitir</span></button>
        </div>
      </div>
    </div>
    <div class="mm-modal" id="mm-modal" hidden></div>
  </div>`;

  function mount(host) {
    host.innerHTML = TEMPLATE;
    const $ = id => host.querySelector('#' + id);
    const el = { root: $('mm'), map: $('mm-map'), load: $('mm-load'), loadMsg: $('mm-load-msg'), retry: $('mm-retry'),
      form: $('mm-form'), q: $('mm-q'), go: $('mm-go'), head: $('mm-head'), navbar: $('mm-navbar'), results: $('mm-results'), gps: $('mm-gps'),
      menu: $('mm-menu'), mbtn: $('mm-mbtn'), toast: $('mm-toast'), attr: $('mm-attr'), dest: $('mm-dest'), start: $('mm-start'), ride: $('mm-ride'), modal: $('mm-modal') };

    const S = { cfg: null, map: null, ready: false, active: false, watch: null, me: null, hadFix: false, follow: true,
      meMarker: null, accCircle: null, dest: null, destMarker: null, route: null, routeLines: [], nav: null,
      ride: null, riding: false, trail: null, tick: null, wl: null, hiddenAt: 0, riders: null, toastT: 0, theme: store.get('mm_theme', 'dark'),
      keepAwake: store.get('mm_wake', '1') === '1' };

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
      el.attr.innerHTML = cfg.tileAttr || '';
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
      if (S.riding && S.ride.add(f) && S.trail) S.trail.addLatLng([f.lat, f.lon]);
      if (S.riding) paintRide();
      if (S.nav) updateNav(f);
      if (S.dest) paintDest();
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
        showResults(list.map((x, i) => `<button type="button" class="mm-ritem" data-i="${i}"><b>${esc(x.title)}</b><span>${esc(x.subtitle)}</span></button>`).join(''));
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

    /* ---------- Hedef ---------- */
    function setDest(x) {
      if (S.nav) stopNav(true);
      clearRoute();
      S.dest = { lat: x.lat, lon: x.lon, title: x.title, subtitle: x.subtitle };
      if (S.destMarker) S.destMarker.remove();
      S.destMarker = window.L.marker([x.lat, x.lon], { keyboard: false, icon: window.L.divIcon({ className: 'mm-icon', iconSize: [32, 40], iconAnchor: [16, 38], html: PIN }) }).addTo(S.map);
      S.follow = false; paintLocate();
      el.dest.hidden = false; paintDest();
      const pad = { paddingTopLeft: [40, 110], paddingBottomRight: [70, 230], maxZoom: 16 };
      if (S.me) S.map.fitBounds([[S.me.lat, S.me.lon], [x.lat, x.lon]], pad); else S.map.setView([x.lat, x.lon], 14);
    }
    function clearDest() {
      if (S.nav) stopNav(true);
      clearRoute();
      if (S.destMarker) { S.destMarker.remove(); S.destMarker = null; }
      S.dest = null; el.dest.hidden = true;
    }
    function paintDest() {
      const d = S.dest; if (!d) return;
      $('mm-dtitle').textContent = d.title || 'Seçilen konum';
      $('mm-dsub').textContent = d.subtitle || '';
      $('mm-dline').textContent = S.me ? 'Kuş uçuşu: ' + fmtDist(haversine(S.me.lat, S.me.lon, d.lat, d.lon)) + ' (yol mesafesi değildir)' : 'Mesafe için konumun bekleniyor…';
      const go = $('mm-navgo'), note = $('mm-dnote');
      go.disabled = !S.cfg.routing;
      note.hidden = S.cfg.routing; note.textContent = 'Rota hesaplama bu sunucuda henüz etkin değil; şimdilik yalnızca hedef gösterilir.';
    }

    /* ---------- Rota / navigasyon ---------- */
    function clearRoute() { S.routeLines.forEach(l => l.remove()); S.routeLines = []; }
    function drawRoute(coords) {
      clearRoute();
      const L = window.L;
      S.routeLines = [L.polyline(coords, { color: '#031420', weight: 11, opacity: 0.75, interactive: false }).addTo(S.map),
                      L.polyline(coords, { color: '#EA8621', weight: 6, opacity: 1, interactive: false }).addTo(S.map)];
    }
    async function fetchRoute(from, to) {
      const p = new URLSearchParams({ from: from.lat.toFixed(6) + ',' + from.lon.toFixed(6), to: to.lat.toFixed(6) + ',' + to.lon.toFixed(6) });
      const r = await fetch('/api/route?' + p, { credentials: 'same-origin' });
      const j = await r.json().catch(() => ({}));
      if (r.status === 503) { S.cfg.routing = false; paintDest(); throw new Error('Rota servisi bu sunucuda etkin değil.'); }
      if (!r.ok || !Array.isArray(j.coords) || j.coords.length < 2) throw new Error(j.error || 'Rota alınamadı.');
      return j;
    }
    $('mm-navgo').addEventListener('click', async () => {
      if (!S.dest || !S.cfg.routing) return;
      if (!S.me) return toast('Önce konumun bulunmalı. GPS bekleniyor…');
      const b = $('mm-navgo'); b.disabled = true; b.querySelector('span').textContent = 'Rota hesaplanıyor…';
      try {
        const j = await fetchRoute(S.me, S.dest);
        drawRoute(j.coords);
        S.nav = { tracker: new RouteTracker(j.coords, j.duration), offSince: 0, lastReroute: Date.now(), busy: false };
        el.dest.hidden = true; $('mm-form').hidden = true; el.navbar.hidden = false;
        $('mm-navto').textContent = S.dest.title || 'Hedef';
        S.follow = true; paintLocate();
        S.map.setView([S.me.lat, S.me.lon], 16);
        updateNav(S.me); measureHead();
        startWatch();
      } catch (err) { toast(err.message || 'Rota alınamadı.', 6000); }
      finally { b.disabled = !S.cfg.routing; b.querySelector('span').textContent = 'Navigasyonu başlat'; }
    });
    function updateNav(f) {
      const n = S.nav; if (!n) return;
      const p = n.tracker.progress(f.lat, f.lon);
      $('mm-navrem').textContent = fmtDist(p.remaining);
      $('mm-naveta').textContent = '≈ ' + fmtEta(n.tracker.eta(p.remaining)) + ' (araç süresiyle)';
      if (p.remaining < 40 && n.tracker.total > 100) { toast('Hedefe ulaştın.', 6000); return stopNav(true, true); }
      const now = Date.now();
      if (p.off > 100) {
        n.offSince = n.offSince || now;
        if (!n.busy && now - n.offSince > 8000 && now - n.lastReroute > 20000) reroute(f);
      } else n.offSince = 0;
    }
    async function reroute(f) {
      const n = S.nav; if (!n || !S.dest) return;
      n.busy = true; n.lastReroute = Date.now(); $('mm-navnote').textContent = 'Rota yeniden hesaplanıyor…';
      try {
        const j = await fetchRoute(f, S.dest);
        if (S.nav !== n) return;
        drawRoute(j.coords); n.tracker = new RouteTracker(j.coords, j.duration); n.offSince = 0;
      } catch (err) { toast(err.message || 'Rota yenilenemedi.', 5000); }
      finally { n.busy = false; $('mm-navnote').textContent = 'Araç rotası · motosiklet için optimize değil'; }
    }
    function stopNav(silent, arrived) {
      if (!S.nav && !arrived) return;
      S.nav = null; clearRoute();
      el.navbar.hidden = true; $('mm-form').hidden = false; measureHead();
      if (arrived) clearDest(); else if (S.dest && !silent) { el.dest.hidden = false; paintDest(); }
      if (!S.active && !S.riding) stopWatch();
    }
    $('mm-navstop').addEventListener('click', () => stopNav(false));
    $('mm-dclear').addEventListener('click', clearDest);

    /* ---------- Sürüş ---------- */
    async function acquireWake() {
      if (!S.keepAwake || !('wakeLock' in navigator) || S.wl) return;
      try { S.wl = await navigator.wakeLock.request('screen'); S.wl.addEventListener('release', () => { S.wl = null; }); } catch {}
    }
    function releaseWake() { try { S.wl && S.wl.release(); } catch {} S.wl = null; }
    function startRide() {
      if (S.riding) return;
      S.ride = new RideStats(Date.now()); S.riding = true;
      S.trail = window.L.polyline([], { color: '#F2A64E', weight: 4, opacity: 0.9, interactive: false }).addTo(S.map);
      if (S.me && Date.now() - S.me.t < 5000 && S.ride.add(S.me)) S.trail.addLatLng([S.me.lat, S.me.lon]);
      el.start.hidden = true; el.ride.hidden = false;
      S.follow = true; paintLocate();
      if (S.me) S.map.setView([S.me.lat, S.me.lon], Math.max(S.map.getZoom(), 16));
      acquireWake(); startWatch();
      S.tick = setInterval(paintRide, 1000); paintRide();
      if (el.gps.dataset.s === 'bad') toast('GPS sinyali zayıf ya da yok; konum geldikçe kayıt başlar.');
    }
    function paintRide() {
      const r = S.ride; if (!r) return;
      const now = Date.now(), sm = r.summary(now);
      const fresh = r.speed != null && now - r.speedAt < 6000;
      $('mm-spd').textContent = fresh ? String(Math.round(kmh(r.speed))) : '—';
      $('mm-sd').textContent = fmtDist(sm.dist);
      $('mm-st').textContent = fmtClock(sm.elapsedS);
      $('mm-sa').textContent = sm.avgKmh == null ? '—' : Math.round(sm.avgKmh) + ' km/h';
      $('mm-sm').textContent = sm.maxKmh == null ? '—' : Math.round(sm.maxKmh) + ' km/h';
    }
    function modal(html) { el.modal.innerHTML = '<div class="mm-mcard" role="dialog" aria-modal="true">' + html + '</div>'; el.modal.hidden = false; const b = el.modal.querySelector('[data-focus]'); if (b) b.focus(); }
    function closeModal() { el.modal.hidden = true; el.modal.innerHTML = ''; }
    $('mm-stop').addEventListener('click', () => {
      if (!S.riding) return;
      modal('<h3>Sürüş bitirilsin mi?</h3><p>Şu ana kadarki ölçümler özet olarak gösterilir.</p><div class="mm-mbtns"><button type="button" class="mm-mb" data-act="cancel">Devam et</button><button type="button" class="mm-mb danger" data-act="end" data-focus>Bitir</button></div>');
    });
    el.start.addEventListener('click', startRide);
    el.modal.addEventListener('click', e => {
      const a = e.target.closest('[data-act]'); if (!a) return;
      if (a.dataset.act === 'cancel' || a.dataset.act === 'close') { closeModal(); if (a.dataset.act === 'close' && S.trail) { S.trail.remove(); S.trail = null; } }
      if (a.dataset.act === 'end') endRide();
    });
    function endRide() {
      clearInterval(S.tick); S.tick = null; releaseWake();
      const sm = S.ride.summary(Date.now());
      S.riding = false; S.ride = null;
      el.ride.hidden = true; el.start.hidden = false;
      if (!S.active && !S.nav) stopWatch();
      if (S.trail && S.trail.getLatLngs().length > 1) S.map.fitBounds(S.trail.getBounds(), { paddingTopLeft: [40, 100], paddingBottomRight: [40, 330], maxZoom: 17 });
      S.follow = false; paintLocate();
      const row = (k, v) => `<div><small>${k}</small><b>${v}</b></div>`;
      modal('<h3>Sürüş özeti</h3><div class="mm-sum">' +
        row('Mesafe', fmtDist(sm.dist)) + row('Süre', fmtClock(sm.elapsedS)) + row('Hareket süresi', fmtClock(sm.moveS)) +
        row('Ort. hız', sm.avgKmh == null ? '—' : Math.round(sm.avgKmh) + ' km/h') + row('Maks. hız', sm.maxKmh == null ? '—' : Math.round(sm.maxKmh) + ' km/h') + '</div>' +
        (sm.gaps ? `<p class="warn">Konum alınamayan ${sm.gaps} kesinti oldu; o aralıklardaki mesafe ölçülmedi.</p>` : '') +
        '<p>Mesafe ve hızlar telefonun GPS ölçümlerinden hesaplanır. Bu sürüş henüz kaydedilmiyor; sürüş geçmişi sonraki aşamada eklenecek.</p>' +
        '<div class="mm-mbtns"><button type="button" class="mm-mb primary" data-act="close" data-focus>Tamam</button></div>');
    }
    document.addEventListener('visibilitychange', () => {
      if (!S.riding) return;
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
    $('mm-wake').addEventListener('change', e => { S.keepAwake = e.target.checked; store.set('mm_wake', S.keepAwake ? '1' : '0'); if (S.riding) (S.keepAwake ? acquireWake() : releaseWake()); });
    if (!('wakeLock' in navigator)) { $('mm-wake').disabled = true; $('mm-wake').checked = false; $('mm-wakenote').textContent = 'Bu tarayıcı ekranı açık tutmayı desteklemiyor. Sürüş boyunca ekranı kendin açık tut; ekran kilitlenirse konum alınamayabilir.'; }
    host.addEventListener('click', e => { if (!el.menu.hidden && !el.menu.contains(e.target)) { el.menu.hidden = true; el.mbtn.setAttribute('aria-expanded', 'false'); } if (!el.results.hidden && !el.head.contains(e.target) && !el.results.contains(e.target)) showResults(''); });
    host.addEventListener('keydown', e => { if (e.key === 'Escape') { el.menu.hidden = true; if (!el.modal.hidden && !S.riding && !el.modal.querySelector('[data-act=end]')) closeModal(); } });
    setTheme(S.theme);

    /* ---------- Başlatma ---------- */
    function boot() {
      el.load.hidden = false; el.retry.hidden = true; el.loadMsg.textContent = 'Harita yükleniyor…';
      const cfgP = fetch('/api/maps/config', { credentials: 'same-origin' }).then(r => { if (!r.ok) throw new Error(r.status === 401 ? 'Oturum süresi dolmuş. Sayfayı yenile.' : 'Harita ayarları alınamadı.'); return r.json(); });
      Promise.all([cfgP, loadLeaflet()]).then(([cfg]) => initMap(cfg)).catch(err => {
        el.loadMsg.textContent = err.message || 'Harita yüklenemedi.'; el.retry.hidden = false;
      });
    }
    el.retry.addEventListener('click', boot);
    boot();

    return {
      activate() { S.active = true; if (S.ready) { S.map.invalidateSize(); measureHead(); startWatch(); } },
      deactivate() { S.active = false; if (!S.riding && !S.nav) stopWatch(); },
      setRiders, flyToMe
    };
  }

  window.MotoMap = { mount, _core: Core };
})();
