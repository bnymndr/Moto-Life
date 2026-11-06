'use strict';
/* Cihazdaki sürüş deposu (IndexedDB) ve sunucuya eşitleme. window.RideStore.
   - Her GPS kaydı geldiği anda ayrı yazılır: sayfa kapansa/çökse en fazla son birkaç saniye kaybolur.
   - Sürüş bitince meta.sync = 'pending' olur; çevrimdışıysa kuyrukta bekler, bağlantı gelince sync() gönderir.
   - Sunucu kimlik (id) ile aynı sürüşü ikinci kez kabul etmez (tekrar gönderim zararsızdır).
   - IndexedDB kullanılamıyorsa (ör. bazı gizli sekmeler) bellek yedeği devreye girer; persistent=false olur ve arayüz uyarır. */
(function () {
  const DB_NAME = 'motolife-rides';
  const clone = o => JSON.parse(JSON.stringify(o));

  class Mem {
    constructor() { this.m = new Map(); this.f = new Map(); }
    async putMeta(m) { this.m.set(m.id, clone(m)); }
    async getMeta(id) { const m = this.m.get(id); return m ? clone(m) : null; }
    async allMeta() { return [...this.m.values()].map(clone); }
    async addFix(id, seq, f) { let a = this.f.get(id); if (!a) this.f.set(id, a = new Map()); a.set(seq, f); }
    async loadFixes(id) { const a = this.f.get(id); return a ? [...a.entries()].sort((x, y) => x[0] - y[0]).map(e => clone(e[1])) : []; }
    async del(id) { this.m.delete(id); this.f.delete(id); }
  }

  class Idb {
    async open() {
      this.db = await new Promise((res, rej) => {
        const o = indexedDB.open(DB_NAME, 1);
        o.onupgradeneeded = () => { const d = o.result; d.createObjectStore('rides', { keyPath: 'id' }); d.createObjectStore('fixes', { keyPath: ['rideId', 'seq'] }); };
        o.onsuccess = () => res(o.result);
        o.onerror = () => rej(o.error || new Error('IndexedDB açılamadı'));
        o.onblocked = () => rej(new Error('IndexedDB engellendi'));
      });
    }
    _tx(stores, mode, fn) {
      return new Promise((res, rej) => {
        const t = this.db.transaction(stores, mode); let out;
        t.oncomplete = () => res(out && 'result' in out ? out.result : undefined);
        t.onerror = () => rej(t.error); t.onabort = () => rej(t.error || new Error('İşlem iptal edildi'));
        out = fn(t);
      });
    }
    putMeta(m) { return this._tx(['rides'], 'readwrite', t => t.objectStore('rides').put(m)); }
    getMeta(id) { return this._tx(['rides'], 'readonly', t => t.objectStore('rides').get(id)).then(m => m || null); }
    allMeta() { return this._tx(['rides'], 'readonly', t => t.objectStore('rides').getAll()).then(a => a || []); }
    addFix(id, seq, f) { return this._tx(['fixes'], 'readwrite', t => t.objectStore('fixes').put({ rideId: id, seq, f })); }
    loadFixes(id) { return this._tx(['fixes'], 'readonly', t => t.objectStore('fixes').getAll(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER]))).then(a => (a || []).map(r => r.f)); }
    del(id) { return this._tx(['rides', 'fixes'], 'readwrite', t => { t.objectStore('fixes').delete(IDBKeyRange.bound([id, 0], [id, Number.MAX_SAFE_INTEGER])); t.objectStore('rides').delete(id); }); }
  }

  const RideStore = {
    persistent: false, s: null, syncing: null,
    async init() {
      if (this.s) return this.persistent;
      try {
        if (!window.indexedDB) throw new Error('IndexedDB yok');
        const s = new Idb(); await s.open();
        await s.putMeta({ id: '__probe', owner: '', status: 'probe' }); await s.del('__probe');   // gerçekten yazılabiliyor mu?
        this.s = s; this.persistent = true;
      } catch (e) { this.s = new Mem(); this.persistent = false; }
      return this.persistent;
    },
    saveMeta(m) { return this.s.putMeta(m); },
    addFix(id, seq, f) { return this.s.addFix(id, seq, f); },
    remove(id) { return this.s.del(id); },
    // Yarım kalmış (sayfa kapanmış/çökmüş) sürüşler: en yeni önce
    async findOpen(owner) {
      return (await this.s.allMeta()).filter(m => m.owner === owner && (m.status === 'active' || m.status === 'paused')).sort((a, b) => b.startedAt - a.startedAt);
    },
    // Saklanan sürüşü RideCore.Recorder.replay'in beklediği biçimde yükle
    async load(id) {
      const m = await this.s.getMeta(id); if (!m) return null;
      return { meta: m, data: { v: 1, id, startedAt: m.startedAt, endedAt: m.endedAt || 0, events: m.events, fixes: await this.s.loadFixes(id) } };
    },
    async counts(owner) {
      const a = (await this.s.allMeta()).filter(m => m.owner === owner && m.status === 'ended');
      return { total: a.length, pending: a.filter(m => m.sync === 'pending').length, failed: a.filter(m => m.sync === 'failed').length };
    },
    async retryFailed(owner) {
      for (const m of (await this.s.allMeta())) if (m.owner === owner && m.sync === 'failed') { m.sync = 'pending'; delete m.syncError; await this.s.putMeta(m); }
    },
    // Bekleyen (bitmiş, henüz gönderilmemiş) sürüşleri sırayla gönder. onState(id, durum, ileti)
    sync(owner, onState) {
      if (this.syncing) return this.syncing;
      this.syncing = this._sync(owner, onState || (() => {})).finally(() => { this.syncing = null; });
      return this.syncing;
    },
    async _sync(owner, onState) {
      const out = { sent: 0, left: 0, failed: 0, offline: false, auth: false };
      const list = (await this.s.allMeta()).filter(m => m.owner === owner && m.status === 'ended' && m.sync === 'pending').sort((a, b) => a.startedAt - b.startedAt);
      for (const m of list) {
        if (typeof navigator !== 'undefined' && navigator.onLine === false) { out.offline = true; out.left++; onState(m.id, 'offline'); continue; }
        onState(m.id, 'sending');
        let r;
        try {
          const fixes = await this.s.loadFixes(m.id);
          r = await fetch('/api/rides', { method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/octet-stream' },
            body: JSON.stringify({ v: 1, id: m.id, startedAt: m.startedAt, endedAt: m.endedAt, events: m.events, fixes }) });
        } catch { out.offline = true; out.left++; onState(m.id, 'offline'); continue; }       // ağ yok / sunucuya ulaşılamadı: kuyrukta kalır
        if (r.ok) { m.sync = 'synced'; m.syncedAt = Date.now(); delete m.syncError; await this.s.putMeta(m); out.sent++; onState(m.id, 'synced'); }
        else if (r.status === 401) { out.auth = true; out.left++; onState(m.id, 'auth'); }
        else if (r.status >= 500 || r.status === 429) { out.left++; onState(m.id, 'retry'); }
        else {                                                                                  // sunucu veriyi reddetti: tekrar denemek işe yaramaz, veri cihazda durur
          const j = await r.json().catch(() => ({}));
          m.sync = 'failed'; m.syncError = j.error || ('HTTP ' + r.status); await this.s.putMeta(m); out.failed++; onState(m.id, 'failed', m.syncError);
        }
      }
      return out;
    }
  };
  window.RideStore = RideStore;
})();
