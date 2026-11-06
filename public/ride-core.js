'use strict';
/* Sürüş kaydı çekirdeği. Tarayıcıda window.RideCore, Node'da require('./public/ride-core.js').
   Aynı kod istemcide canlı ölçüm için, sunucuda gelen sürüşü yeniden hesaplamak için kullanılır.

   Veri modeli (saklanan/gönderilen sürüş):
     { v:1, id, startedAt, endedAt, events:[[t,'start'|'pause'|'resume'|'end',n],…], fixes:[[t,lat,lon,acc,speed|null,flag],…] }
   n: olay anına kadar saklanmış nokta sayısı. Yeniden oynatma olayları saate değil bu sıraya göre uygular
   (cihaz saati ile GPS saati arasındaki küçük farklar sonucu değiştirmez).
   t: ms (Unix). acc: metre. speed: m/sn (cihaz verdiyse, yoksa null). flag: 0 kabul, 1 zayıf doğruluk (elendi),
   2 GPS sıçraması (elendi), 3 yeni referans (boşluk ya da art arda sıçrama sonrası; mesafe eklenmedi).
   Elenen konumlar da saklanır (kanıt/yeniden hesap için) ama mesafeye, hıza ve rotaya girmez.
   Özet, bu ham veriden her zaman yeniden hesaplanabilir (Recorder.replay). */
(function (root) {
  const MAX_ACC = 50;          // m: bundan kötü konumlar elenir
  const MOVE_MS = 0.8;         // m/sn (≈2,9 km/h): altı "duruyor" sayılır
  const MAX_SPEED = 83;        // m/sn (≈300 km/h): üstü hatalı ölçüm
  const MAX_ACCEL = 12;        // m/sn²: bir motosiklet için üst sınır (sıçrama tespiti)
  const GAP_S = 30, GAP_M = 100, CONSEC = 3;
  const MAX_FIXES = 30000;     // ≈ 8 saatlik 1 Hz kayıt; dolunca kayıt durur ve kullanıcıya bildirilir
  const ID_RE = /^r_[a-z0-9]{8,32}$/;
  const EVENTS = ['start', 'pause', 'resume', 'end'];

  const toRad = d => d * Math.PI / 180;
  const r1 = v => Math.round(v * 10) / 10, r2 = v => Math.round(v * 100) / 100, r6 = v => Math.round(v * 1e6) / 1e6;
  function haversine(lat1, lon1, lat2, lon2) {
    const a = Math.sin(toRad(lat2 - lat1) / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(toRad(lon2 - lon1) / 2) ** 2;
    return 2 * 6371000 * Math.asin(Math.min(1, Math.sqrt(a)));
  }
  const newId = () => 'r_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

  class Recorder {
    constructor(id) {
      this.id = id || newId(); this.status = 'idle';
      this.startedAt = 0; this.endedAt = 0; this.events = []; this.fixes = [];
      this.activeMs = 0; this.activeSince = 0; this.pauses = []; this.pausedMs = 0;
      this.dist = 0; this.movingMs = 0; this.max = 0;
      this.rejAcc = 0; this.rejJump = 0; this.gaps = 0; this.reanchors = 0; this.consec = 0;
      this.last = null; this.anchor = null; this.speed = null; this.speedAt = 0; this.prevDisp = null;
      this.track = []; this.limitReached = false; this.lastFixT = 0;
    }
    /* ---- yaşam döngüsü ---- */
    start(t) { if (this.status !== 'idle') return false; this.status = 'active'; this.startedAt = t; this.activeSince = t; this.events.push([t, 'start', this.fixes.length]); return true; }
    pause(t) {
      if (this.status !== 'active') return false;
      this.activeMs += Math.max(0, t - this.activeSince); this.pauses.push({ from: t, to: null }); this.events.push([t, 'pause', this.fixes.length]);
      this.status = 'paused'; this._reset(); return true;     // duraklatma sırasındaki yer değişimi mesafeye eklenmez
    }
    resume(t) {
      if (this.status !== 'paused') return false;
      const p = this.pauses[this.pauses.length - 1]; p.to = t; this.pausedMs += Math.max(0, t - p.from);
      this.activeSince = t; this.status = 'active'; this.events.push([t, 'resume', this.fixes.length]); return true;
    }
    end(t) {
      if (this.status === 'active') this.activeMs += Math.max(0, t - this.activeSince);
      else if (this.status === 'paused') { const p = this.pauses[this.pauses.length - 1]; p.to = t; this.pausedMs += Math.max(0, t - p.from); }
      else return false;
      this.status = 'ended'; this.endedAt = t; this.events.push([t, 'end', this.fixes.length]); return true;
    }
    _reset() { this.last = null; this.anchor = null; this.speed = null; this.prevDisp = null; this.consec = 0; }
    _ref(rec, sp) {              // yeni referans noktası: mesafe eklemeden konumu sabitle
      const [t, lat, lon, acc] = rec;
      this.last = { lat, lon, acc, t, speed: sp }; this.anchor = { lat, lon, t };
      this.speed = sp; this.speedAt = t; this.prevDisp = null; this.consec = 0; this.track.push([lat, lon]);
    }

    /* ---- GPS konumu ekle. Geri dönüş: saklanacak kayıt dizisi ya da null (yok sayıldı/kaydedilmez) ---- */
    addFix(f) {
      if (this.status !== 'active') return null;
      if (this.fixes.length >= MAX_FIXES) { this.limitReached = true; return null; }
      const t = Math.round(f.t), lat = r6(f.lat), lon = r6(f.lon), acc = r1(f.acc);
      if (![t, lat, lon, acc].every(Number.isFinite) || Math.abs(lat) > 90 || Math.abs(lon) > 180) return null;
      if (t < this.activeSince - 1000) return null;                 // önbellekten gelen eski konum
      const p = this.last;
      if (t <= this.lastFixT) return null;                           // yinelenen / sıra dışı
      const sp = f.speed != null && Number.isFinite(f.speed) && f.speed >= 0 && f.speed <= MAX_SPEED ? r2(f.speed) : null;
      const rec = [t, lat, lon, acc, sp, 0];
      this.fixes.push(rec); this.lastFixT = t;
      if (!(acc <= MAX_ACC)) { rec[5] = 1; this.rejAcc++; return rec; }          // doğruluğu kötü: tamamen yok say
      if (!p) { this._ref(rec, sp); return rec; }                                 // ilk nokta (başlangıç / devam sonrası)
      const dt = (t - p.t) / 1000, d = haversine(p.lat, p.lon, lat, lon);
      if (dt > GAP_S && d > GAP_M) { this.gaps++; rec[5] = 3; this._ref(rec, sp); return rec; }   // uzun boşluk + büyük sıçrama
      const maxD = (Math.max(p.speed || 0, sp || 0) + MAX_ACCEL * dt) * dt + p.acc + acc + 10;    // fiziksel olarak mümkün en büyük yer değişimi
      if (dt <= GAP_S && (d > maxD || d / dt > MAX_SPEED)) {
        this.rejJump++; this.consec++;
        if (this.consec >= CONSEC) { rec[5] = 3; this.reanchors++; this._ref(rec, sp); }   // art arda 3 "sıçrama": gerçekten oradadır, yeni referans
        else rec[5] = 2;
        return rec;
      }
      this.consec = 0;
      let disp = sp, moving = false;
      if (sp != null) {                                              // cihaz hız veriyor
        if (sp >= MOVE_MS) { moving = true; this.dist += d; this.movingMs += Math.min(dt, 30) * 1000; this.anchor = { lat, lon, t }; }
        else disp = 0;
      } else {                                                       // hız yok: "çapa" yöntemi (titreme mesafeye eklenmez)
        const a = this.anchor || { lat: p.lat, lon: p.lon, t: p.t };
        const da = haversine(a.lat, a.lon, lat, lon), dta = Math.max(0.001, (t - a.t) / 1000);
        if (da > Math.max(acc, 6)) { moving = true; this.dist += da; this.movingMs += Math.min(dta, 30) * 1000; disp = da / dta; this.anchor = { lat, lon, t }; }
        else disp = 0;
      }
      // Maksimum hız: iyi doğruluk + mantıklı değer + bir önceki ölçümle tutarlı ivme
      if (moving && disp != null && acc <= 30 && disp <= MAX_SPEED && this.prevDisp != null && Math.abs(disp - this.prevDisp) <= 15 * dt + 2) this.max = Math.max(this.max, disp);
      this.prevDisp = disp; this.speed = disp; this.speedAt = t;
      this.last = { lat, lon, acc, t, speed: sp }; this.track.push([lat, lon]);
      return rec;
    }

    /* ---- Özet. now: ms (devam eden sürüş için) ---- */
    summary(now) {
      const open = this.status === 'paused' ? this.pauses[this.pauses.length - 1] : null;
      const act = this.activeMs + (this.status === 'active' ? Math.max(0, now - this.activeSince) : 0);
      const pausedMs = this.pausedMs + (open ? Math.max(0, now - open.from) : 0);
      const durS = act / 1000, movS = Math.min(this.movingMs / 1000, durS);
      return {
        status: this.status, startedAt: this.startedAt, endedAt: this.endedAt,
        durationS: r1(durS),                       // aktif süre: duraklatmalar HARİÇ, trafikte/durakta beklemeler DAHİL
        movingS: r1(movS),                         // hareket süresi
        stoppedS: r1(Math.max(0, durS - movS)),    // duruş (duraklatma değil; hareketsiz geçen aktif süre)
        pausedS: r1(pausedMs / 1000), pauseCount: this.pauses.length,
        distM: r1(this.dist),
        avgTotalKmh: durS >= 10 ? r1(this.dist / durS * 3.6) : null,    // mesafe / aktif süre
        avgMovingKmh: movS >= 10 ? r1(this.dist / movS * 3.6) : null,   // mesafe / hareket süresi
        maxKmh: this.max > 0 ? r1(this.max * 3.6) : null,
        points: this.track.length, rejectedAcc: this.rejAcc, rejectedJump: this.rejJump, gaps: this.gaps, reanchors: this.reanchors,
        limitReached: this.limitReached
      };
    }
    toJSON() { return { v: 1, id: this.id, startedAt: this.startedAt, endedAt: this.endedAt, events: this.events, fixes: this.fixes }; }

    /* ---- Ham veriden yeniden kur: aynı kural, aynı sonuç ---- */
    static replay(data) {
      const r = new Recorder(data.id), fx = data.fixes; let j = 0;
      const feed = n => { while (j < n && j < fx.length) { const f = fx[j++]; r.addFix({ t: f[0], lat: f[1], lon: f[2], acc: f[3], speed: f[4] }); } };
      for (const [t, k, n] of data.events) {
        feed(n);
        if (k === 'start') r.start(t); else if (k === 'pause') r.pause(t); else if (k === 'resume') r.resume(t); else if (k === 'end') r.end(t);
      }
      feed(fx.length);
      return r;
    }
  }
  const summarize = (data, now) => Recorder.replay(data).summary(data.endedAt || now || Date.now());

  /* ---- Sunucuya gelen/saklanan sürüş verisini doğrula. Geri dönüş: hata metni ya da null ---- */
  function validateRide(d) {
    if (!d || typeof d !== 'object' || d.v !== 1) return 'Sürüş verisi geçersiz.';
    if (typeof d.id !== 'string' || !ID_RE.test(d.id)) return 'Sürüş kimliği geçersiz.';
    const ok = Number.isFinite;
    if (!ok(d.startedAt) || !ok(d.endedAt) || d.startedAt < 1.5e12 || d.endedAt < d.startedAt || d.endedAt > Date.now() + 864e5) return 'Sürüş zamanları geçersiz.';
    if (!Array.isArray(d.events) || d.events.length < 2 || d.events.length > 2000) return 'Sürüş olayları geçersiz.';
    if (!Array.isArray(d.fixes) || d.fixes.length > MAX_FIXES) return 'Konum sayısı sınırı aşıldı.';
    let st = 'idle', prevN = 0;
    for (const e of d.events) {
      if (!Array.isArray(e) || e.length !== 3 || !ok(e[0]) || !EVENTS.includes(e[1]) || !Number.isInteger(e[2]) || e[2] < prevN || e[2] > d.fixes.length) return 'Sürüş olayları geçersiz.';
      prevN = e[2];
      const next = { idle: { start: 'active' }, active: { pause: 'paused', end: 'ended' }, paused: { resume: 'active', end: 'ended' }, ended: {} }[st][e[1]];
      if (!next) return 'Sürüş olay sırası geçersiz.';
      st = next;
    }
    if (st !== 'ended' || d.events[0][0] !== d.startedAt || d.events[d.events.length - 1][0] !== d.endedAt) return 'Sürüş tamamlanmamış.';
    let pt = 0;
    for (const f of d.fixes) {
      if (!Array.isArray(f) || f.length !== 6 || !f.slice(0, 4).every(ok) || (f[4] !== null && !ok(f[4])) || !ok(f[5])) return 'Konum kaydı geçersiz.';
      if (Math.abs(f[1]) > 90 || Math.abs(f[2]) > 180 || f[3] < 0 || f[3] > 1e5 || f[0] < pt || f[5] < 0 || f[5] > 3) return 'Konum kaydı geçersiz.';
      pt = f[0];
    }
    return null;
  }

  const api = { MAX_ACC, MOVE_MS, MAX_FIXES, ID_RE, haversine, Recorder, summarize, validateRide, newId };
  if (typeof module !== 'undefined' && module.exports) module.exports = api; else root.RideCore = api;
})(typeof window !== 'undefined' ? window : globalThis);
