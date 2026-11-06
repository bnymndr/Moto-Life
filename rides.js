'use strict';
// Sürüş kayıtları: her kullanıcının sürüşleri data/rides/<kullanıcı-id>/ altında, sürüş başına iki dosya:
//   <id>.json      tam kayıt (olaylar + ham GPS noktaları + sunucunun yeniden hesapladığı özet)
//   <id>.sum.json  yalnızca özet (liste için)
// Kayıtlar değişmezdir: aynı id ikinci kez gelirse yeniden yazılmaz, var olan özet döner (güvenli tekrar gönderim).
// server.js içinden: require('./rides')({ app, express, userFromCookie, dataDir })
const fs = require('fs');
const path = require('path');
const RC = require('./public/ride-core.js');

const MAX_BODY = '3mb';
const MAX_RIDES_PER_USER = 5000;

module.exports = function mountRides({ app, express, userFromCookie, dataDir }) {
  const ROOT = path.join(dataDir, 'rides');
  fs.mkdirSync(ROOT, { recursive: true });

  const hits = new Map();
  function limited(key, max) {
    const now = Date.now(), arr = (hits.get(key) || []).filter(t => now - t < 60000);
    if (arr.length >= max) { hits.set(key, arr); return true; }
    arr.push(now); hits.set(key, arr); return false;
  }
  setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (!v.some(t => now - t < 60000)) hits.delete(k); }, 5 * 60000).unref();

  const authed = (req, res) => {
    const u = userFromCookie(req.headers.cookie);
    if (!u) { res.status(401).json({ error: 'Giriş gerekli.' }); return null; }
    return u;
  };
  const userDir = u => path.join(ROOT, String(u.id).replace(/[^A-Za-z0-9_-]/g, ''));
  const readJson = f => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  function writeAtomic(file, text) {
    const tmp = file + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, text); fs.renameSync(tmp, file);
  }

  // İçerik türü application/octet-stream olduğundan genel 10 KB'lık JSON sınırına takılmaz (sosyal fotoğraf yüklemesiyle aynı yöntem).
  app.post('/api/rides', express.raw({ type: 'application/octet-stream', limit: MAX_BODY }), (req, res) => {
    const u = authed(req, res); if (!u) return;
    if (limited('up:' + u.id, 30)) return res.status(429).json({ error: 'Çok sık gönderim yaptın. Biraz bekle.' });
    if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Boş istek.' });
    let data;
    try { data = JSON.parse(req.body.toString('utf8')); } catch { return res.status(400).json({ error: 'Sürüş verisi okunamadı.' }); }
    const err = RC.validateRide(data);
    if (err) return res.status(400).json({ error: err });
    const dir = userDir(u), file = path.join(dir, data.id + '.json'), sumFile = path.join(dir, data.id + '.sum.json');
    fs.mkdirSync(dir, { recursive: true });
    if (fs.existsSync(file)) {                                           // aynı sürüş daha önce alınmış
      const s = readJson(sumFile);
      return res.json({ ok: true, duplicate: true, id: data.id, summary: s ? s.summary : null });
    }
    if (fs.readdirSync(dir).length > MAX_RIDES_PER_USER * 2) return res.status(400).json({ error: 'Kayıtlı sürüş sınırına ulaşıldı.' });
    const summary = RC.summarize(data);                                  // istemcinin özetine güvenilmez: ham veriden yeniden hesaplanır
    const full = { v: 1, id: data.id, startedAt: data.startedAt, endedAt: data.endedAt, events: data.events, fixes: data.fixes, summary, receivedAt: Date.now() };
    try {
      writeAtomic(file, JSON.stringify(full));
      writeAtomic(sumFile, JSON.stringify({ id: data.id, startedAt: data.startedAt, endedAt: data.endedAt, summary }));
    } catch { return res.status(500).json({ error: 'Sürüş sunucuya yazılamadı.' }); }
    res.json({ ok: true, id: data.id, summary });
  });

  app.get('/api/rides', (req, res) => {
    const u = authed(req, res); if (!u) return;
    const dir = userDir(u);
    let names = []; try { names = fs.readdirSync(dir).filter(n => n.endsWith('.sum.json')); } catch {}
    names.sort().reverse();                                              // kimlik zamanla başladığı için yaklaşık en yeni önce
    const rides = names.slice(0, 100).map(n => readJson(path.join(dir, n))).filter(Boolean).sort((a, b) => b.startedAt - a.startedAt);
    res.json({ rides });
  });

  app.get('/api/rides/:id', (req, res) => {
    const u = authed(req, res); if (!u) return;
    const id = String(req.params.id || '');
    if (!RC.ID_RE.test(id)) return res.status(400).json({ error: 'Geçersiz sürüş kimliği.' });
    const r = readJson(path.join(userDir(u), id + '.json'));
    if (!r) return res.status(404).json({ error: 'Sürüş bulunamadı.' });
    res.json(r);
  });

  app.use('/api/rides', (err, req, res, next) => {                      // gövde çok büyük / bozuk
    res.status(err.status || 400).json({ error: err.type === 'entity.too.large' ? 'Sürüş verisi çok büyük.' : 'İstek hatalı.' });
  });
};
