'use strict';
// Sosyal modül: profil, gönderi akışı, arkadaşlık sistemi ve canlı mesajlaşma (REST + Socket.IO).
// server.js içinden: require('./social')({ app, io, users, userFromCookie, uname, dataDir })
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');

module.exports = function mountSocial({ app, io, users, userFromCookie, uname, dataDir }) {
  // ---------- Depo (data/social.json, gecikmeli ve atomik yazım) ----------
  const FILE = path.join(dataDir, 'social.json');
  const db = { posts: [], friends: {}, requests: [], messages: {}, profiles: {}, images: {} };
  const IMG_DIR = path.join(dataDir, 'social-img');
  fs.mkdirSync(IMG_DIR, { recursive: true });
  try { Object.assign(db, JSON.parse(fs.readFileSync(FILE, 'utf8'))); } catch {}
  let timer = null;
  const flush = () => {
    if (!timer) return;
    clearTimeout(timer); timer = null;
    try { fs.writeFileSync(FILE + '.tmp', JSON.stringify(db)); fs.renameSync(FILE + '.tmp', FILE); }
    catch (e) { console.error('Sosyal veri yazılamadı:', e.message); }
  };
  const save = () => { if (!timer) timer = setTimeout(flush, 400); };
  process.on('exit', flush);
  ['SIGINT', 'SIGTERM'].forEach(sig => process.on(sig, () => { flush(); process.exit(0); }));   // Ctrl+C ile kapanırken bekleyen kayıt yazılır

  // ---------- Yardımcılar ----------
  const MAX_POSTS = 3000, MAX_MSGS = 500, MAX_IMG = 700 * 1024;
  const MOODS = ['mutlu', 'heyecanli', 'havali', 'huzurlu', 'asik', 'ozgur', 'enerjik', 'eglenceli', 'minnettar', 'yorgun', 'uzgun', 'kizgin'];
  const mood = v => (MOODS.includes(v) ? v : '');
  const imgFile = id => path.join(IMG_DIR, id + '.jpg');
  const dropImage = id => { if (!id) return; delete db.images[id]; fs.unlink(imgFile(id), () => {}); };
  const rid = () => crypto.randomBytes(8).toString('hex');
  const txt = (s, n) => String(s == null ? '' : s).replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '').trim().slice(0, n);
  const lower = s => String(s || '').toLocaleLowerCase('tr');
  const byName = n => [...users.values()].find(u => lower(uname(u)) === lower(n));
  const pairKey = (a, b) => (a < b ? a + '_' + b : b + '_' + a);
  const isFriend = (a, b) => (db.friends[a] || []).includes(b);
  const online = uid => ((io.sockets.adapter.rooms.get('u:' + uid) || { size: 0 }).size) > 0;
  const avatarVer = u => {
    if (!u.avatar) return '';
    let h = u.avatar.length;
    for (let i = 0; i < u.avatar.length; i += 997) h = (h * 31 + u.avatar.charCodeAt(i)) | 0;
    return (h >>> 0).toString(36);
  };
  const GONE = { username: 'silinmis', name: 'Silinmiş Kullanıcı', av: '', bike: '' };
  const card = u => u ? ({
    username: uname(u), name: [u.firstName, u.lastName].filter(Boolean).join(' ') || uname(u),
    av: avatarVer(u), bike: [u.bikeBrand, u.bikeModel].filter(Boolean).join(' ')
  }) : GONE;
  const cardOf = uid => card(users.get(uid));
  const hits = new Map();
  const limited = (key, max, ms) => {                       // kayan pencere: ms içinde en fazla max işlem
    const now = Date.now(), a = (hits.get(key) || []).filter(t => now - t < ms);
    const over = a.length >= max;
    if (!over) a.push(now);
    hits.set(key, a);
    return over;
  };
  setInterval(() => { const now = Date.now(); for (const [k, a] of hits) if (!a.length || now - a[a.length - 1] > 120000) hits.delete(k); }, 60000).unref();
  setInterval(() => {                                       // 1 saatten eski, gönderiye eklenmemiş yüklemeleri sil
    const old = Date.now() - 3600000;
    for (const [id, m] of Object.entries(db.images)) if (!m.post && m.at < old) { dropImage(id); save(); }
  }, 600000).unref();
  const toUser = (uid, ev, payload) => io.to('u:' + uid).emit(ev, payload);
  const toFriends = (uid, ev, payload) => (db.friends[uid] || []).forEach(f => toUser(f, ev, payload));

  const stats = uid => {
    const mine = db.posts.filter(p => p.uid === uid);
    return { posts: mine.length, friends: (db.friends[uid] || []).length, likes: mine.reduce((n, p) => n + p.likes.length, 0) };
  };
  const profile = u => {
    const p = db.profiles[u.id] || {};
    return { ...card(u), bio: p.bio || '', status: p.status || '', mood: p.mood || '', statusAt: p.statusAt || 0, since: u.createdAt || 0, stats: stats(u.id) };
  };
  const relation = (meId, other) => {
    if (isFriend(meId, other.id)) return { rel: 'friend' };
    const out = db.requests.find(r => r.from === meId && r.to === other.id);
    if (out) return { rel: 'outgoing', requestId: out.id };
    const inc = db.requests.find(r => r.from === other.id && r.to === meId);
    if (inc) return { rel: 'incoming', requestId: inc.id };
    return { rel: 'none' };
  };
  const makeFriends = (a, b) => {
    db.friends[a] = [...new Set([...(db.friends[a] || []), b])];
    db.friends[b] = [...new Set([...(db.friends[b] || []), a])];
    db.requests = db.requests.filter(r => !((r.from === a && r.to === b) || (r.from === b && r.to === a)));
  };
  const visibleTo = (viewer, authorId) => viewer === authorId || isFriend(viewer, authorId);
  const postView = (p, viewer) => ({
    id: p.id, author: cardOf(p.uid), text: p.text, at: p.at, mood: p.mood || '', image: p.image ? '/api/social/img/' + p.image : '', likes: p.likes.length, liked: p.likes.includes(viewer),
    commentCount: p.comments.length, mine: p.uid === viewer,
    comments: p.comments.slice(-20).map(c => ({ id: c.id, author: cardOf(c.uid), text: c.text, at: c.at }))
  });
  const page = (list, req, viewer) => {                      // en yeni üstte; ?before=<zaman> ile sayfalama
    const before = Number(req.query.before) || Infinity, size = 20;
    const rows = list.filter(p => p.at < before).sort((a, b) => b.at - a.at);
    return { posts: rows.slice(0, size).map(p => postView(p, viewer)), more: rows.length > size };
  };
  const thread = (a, b) => db.messages[pairKey(a, b)] || [];
  const unreadOf = (meId, otherId) => thread(meId, otherId).filter(m => m.to === meId && !m.read).length;
  const msgOut = (m, cid) => ({ id: m.id, from: uname(users.get(m.from)), to: uname(users.get(m.to)), text: m.text, at: m.at, read: m.read, cid });

  function sendDm(u, toName, text, cid) {                   // hem soket hem REST kullanır
    const o = byName(toName), t = txt(text, 1000);
    if (!o || o.id === u.id || !isFriend(u.id, o.id)) return { error: 'Bu kullanıcıyla arkadaş değilsiniz.' };
    if (!t) return { error: 'Mesaj boş olamaz.' };
    if (limited('dm:' + u.id, 20, 10000)) return { error: 'Çok hızlı yazıyorsun, biraz bekle.' };
    const m = { id: rid(), from: u.id, to: o.id, text: t, at: Date.now(), read: false };
    const k = pairKey(u.id, o.id), arr = db.messages[k] || (db.messages[k] = []);
    arr.push(m);
    if (arr.length > MAX_MSGS) arr.splice(0, arr.length - MAX_MSGS);
    save();
    const out = msgOut(m, cid);
    io.to('u:' + o.id).to('u:' + u.id).emit('dm:new', out);   // gönderenin diğer sekmeleri de görür
    return { ok: true, message: out };
  }
  function markRead(u, other) {
    let n = 0;
    for (const m of thread(u.id, other.id)) if (m.to === u.id && !m.read) { m.read = true; n++; }
    if (n) { save(); toUser(other.id, 'dm:read', { by: uname(u) }); }
    return n;
  }

  // ---------- REST ----------
  const r = express.Router();
  r.use((req, res, next) => {
    const u = userFromCookie(req.headers.cookie);
    if (!u) return res.status(401).json({ error: 'Giriş gerekli.' });
    req.u = u; next();
  });
  const fail = (res, code, error) => res.status(code).json({ error });

  // Profil
  r.get('/me', (req, res) => res.json({ me: profile(req.u) }));
  r.put('/profile', (req, res) => {
    const p = db.profiles[req.u.id] || (db.profiles[req.u.id] = {}), b = req.body || {};
    if (b.bio !== undefined) p.bio = txt(b.bio, 160);
    const before = (p.status || '') + '|' + (p.mood || '');
    if (b.mood !== undefined) p.mood = mood(b.mood);
    if (b.status !== undefined) p.status = txt(b.status, 80);
    if (((p.status || '') + '|' + (p.mood || '')) !== before) p.statusAt = (p.status || p.mood) ? Date.now() : 0;   // durum ya da duygu değişince zaman damgası yenilenir
    save();
    toFriends(req.u.id, 'social:status', { username: uname(req.u), status: p.status || '', mood: p.mood || '', statusAt: p.statusAt || 0 });
    res.json({ me: profile(req.u) });
  });
  r.get('/avatar/:username', (req, res) => {
    const u = byName(req.params.username), m = u && /^data:(image\/(?:jpeg|png|webp));base64,(.+)$/.exec(u.avatar || '');
    if (!m) return res.status(404).end();
    res.set({ 'Content-Type': m[1], 'Cache-Control': 'private, max-age=86400' });
    res.send(Buffer.from(m[2], 'base64'));
  });
  r.get('/users/:username', (req, res) => {
    const o = byName(req.params.username);
    if (!o) return fail(res, 404, 'Kullanıcı bulunamadı.');
    const self = o.id === req.u.id;
    res.json({ profile: profile(o), ...(self ? { rel: 'self' } : relation(req.u.id, o)), locked: !visibleTo(req.u.id, o.id) });
  });
  r.get('/users/:username/posts', (req, res) => {
    const o = byName(req.params.username);
    if (!o) return fail(res, 404, 'Kullanıcı bulunamadı.');
    if (!visibleTo(req.u.id, o.id)) return res.json({ posts: [], more: false, locked: true });
    res.json(page(db.posts.filter(p => p.uid === o.id), req, req.u.id));
  });

  // Fotoğraf: istemci küçültüp JPEG gönderir (image/jpeg gövdesi), sunucu doğrular ve dosyaya yazar
  r.post('/upload', express.raw({ type: 'image/jpeg', limit: MAX_IMG }), (req, res) => {
    const b = req.body;
    if (!Buffer.isBuffer(b) || b.length < 1000 || b[0] !== 0xFF || b[1] !== 0xD8 || b[2] !== 0xFF) return fail(res, 400, 'Geçerli bir JPEG fotoğraf gönder.');
    if (limited('up:' + req.u.id, 10, 60000)) return fail(res, 429, 'Çok sık fotoğraf yüklüyorsun, biraz bekle.');
    const id = rid();
    fs.writeFile(imgFile(id), b, err => {
      if (err) return fail(res, 500, 'Fotoğraf kaydedilemedi.');
      db.images[id] = { uid: req.u.id, at: Date.now(), post: null }; save();
      res.json({ image: id });
    });
  });
  r.get('/img/:id', (req, res) => {
    const id = req.params.id, rec = /^[0-9a-f]{16}$/.test(id) && db.images[id];
    const post = rec && rec.post && db.posts.find(x => x.id === rec.post);
    if (!rec || !(rec.uid === req.u.id || (post && visibleTo(req.u.id, post.uid)))) return res.status(404).end();
    res.set({ 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, max-age=604800, immutable' });
    fs.createReadStream(imgFile(id)).on('error', () => res.status(404).end()).pipe(res);
  });

  // Akış
  r.get('/feed', (req, res) => {
    const ok = new Set([req.u.id, ...(db.friends[req.u.id] || [])]);
    res.json(page(db.posts.filter(p => ok.has(p.uid)), req, req.u.id));
  });
  r.post('/posts', (req, res) => {
    const b = req.body || {}, t = txt(b.text, 500), img = String(b.image || '');
    const rec = img && db.images[img];
    if (img && (!rec || rec.uid !== req.u.id || rec.post)) return fail(res, 400, 'Fotoğraf bulunamadı, tekrar yükle.');
    if (!t && !img) return fail(res, 400, 'Gönderi boş olamaz.');
    if (limited('post:' + req.u.id, 8, 60000)) return fail(res, 429, 'Çok sık paylaşım yapıyorsun, biraz bekle.');
    const p = { id: rid(), uid: req.u.id, text: t, at: Date.now(), likes: [], comments: [], mood: mood(b.mood), image: img };
    if (rec) rec.post = p.id;
    db.posts.push(p);
    if (db.posts.length > MAX_POSTS) db.posts.splice(0, db.posts.length - MAX_POSTS).forEach(x => dropImage(x.image));
    save();
    toFriends(req.u.id, 'social:post', { id: p.id, username: uname(req.u) });
    res.json({ post: postView(p, req.u.id) });
  });
  const findPost = (req, res) => {
    const p = db.posts.find(x => x.id === req.params.id);
    if (!p || !visibleTo(req.u.id, p.uid)) { fail(res, 404, 'Gönderi bulunamadı.'); return null; }
    return p;
  };
  r.delete('/posts/:id', (req, res) => {
    const i = db.posts.findIndex(x => x.id === req.params.id && x.uid === req.u.id);
    if (i < 0) return fail(res, 404, 'Gönderi bulunamadı.');
    dropImage(db.posts[i].image);
    db.posts.splice(i, 1); save();
    res.json({ ok: true });
  });
  r.post('/posts/:id/like', (req, res) => {
    const p = findPost(req, res); if (!p) return;
    const i = p.likes.indexOf(req.u.id);
    if (i >= 0) p.likes.splice(i, 1); else p.likes.push(req.u.id);
    save();
    res.json({ liked: i < 0, likes: p.likes.length });
  });
  r.post('/posts/:id/comments', (req, res) => {
    const p = findPost(req, res); if (!p) return;
    const t = txt((req.body || {}).text, 300);
    if (!t) return fail(res, 400, 'Yorum boş olamaz.');
    if (limited('cm:' + req.u.id, 20, 60000)) return fail(res, 429, 'Çok sık yorum yapıyorsun, biraz bekle.');
    const c = { id: rid(), uid: req.u.id, text: t, at: Date.now() };
    p.comments.push(c); save();
    if (p.uid !== req.u.id) toUser(p.uid, 'social:notify', { type: 'comment', by: uname(req.u), postId: p.id });
    res.json({ comment: { id: c.id, author: card(req.u), text: c.text, at: c.at }, commentCount: p.comments.length });
  });

  // Arkadaşlık
  r.get('/search', (req, res) => {
    const q = lower(txt(req.query.q, 40));
    if (q.length < 2) return res.json({ users: [] });
    const rows = [...users.values()].filter(u => u.id !== req.u.id &&
      (lower(uname(u)).includes(q) || lower((u.firstName || '') + ' ' + (u.lastName || '')).includes(q))).slice(0, 10);
    res.json({ users: rows.map(u => ({ ...card(u), ...relation(req.u.id, u) })) });
  });
  r.get('/friends', (req, res) => {
    const id = req.u.id;
    const friends = (db.friends[id] || []).map(fid => {
      const f = users.get(fid); if (!f) return null;
      const last = thread(id, fid).slice(-1)[0];
      return { ...card(f), online: online(fid), status: (db.profiles[fid] || {}).status || '', unread: unreadOf(id, fid),
               last: last ? { text: last.text, at: last.at, mine: last.from === id } : null };
    }).filter(Boolean).sort((a, b) => ((b.last && b.last.at) || 0) - ((a.last && a.last.at) || 0) || a.name.localeCompare(b.name, 'tr'));
    res.json({
      friends,
      incoming: db.requests.filter(x => x.to === id).map(x => ({ id: x.id, user: cardOf(x.from), at: x.at })),
      outgoing: db.requests.filter(x => x.from === id).map(x => ({ id: x.id, user: cardOf(x.to), at: x.at })),
      unreadTotal: friends.reduce((n, f) => n + f.unread, 0)
    });
  });
  r.post('/requests', (req, res) => {
    const o = byName((req.body || {}).username);
    if (!o) return fail(res, 404, 'Kullanıcı bulunamadı.');
    if (o.id === req.u.id) return fail(res, 400, 'Kendine istek gönderemezsin.');
    if (limited('rq:' + req.u.id, 20, 60000)) return fail(res, 429, 'Çok fazla istek gönderdin, biraz bekle.');
    const rel = relation(req.u.id, o);
    if (rel.rel === 'friend') return fail(res, 409, 'Zaten arkadaşsınız.');
    if (rel.rel === 'outgoing') return fail(res, 409, 'İstek zaten gönderilmiş.');
    if (rel.rel === 'incoming') {                            // karşı taraf zaten istek göndermişse doğrudan arkadaş olur
      makeFriends(req.u.id, o.id); save();
      toUser(o.id, 'social:friends', {}); toUser(req.u.id, 'social:friends', {});
      return res.json({ rel: 'friend' });
    }
    const q = { id: rid(), from: req.u.id, to: o.id, at: Date.now() };
    db.requests.push(q); save();
    toUser(o.id, 'social:request', { id: q.id, from: card(req.u) });
    res.json({ rel: 'outgoing', requestId: q.id });
  });
  r.post('/requests/:id/accept', (req, res) => {
    const q = db.requests.find(x => x.id === req.params.id && x.to === req.u.id);
    if (!q) return fail(res, 404, 'İstek bulunamadı.');
    makeFriends(q.from, q.to); save();
    toUser(q.from, 'social:friends', {}); toUser(q.to, 'social:friends', {});
    res.json({ rel: 'friend' });
  });
  r.delete('/requests/:id', (req, res) => {                  // reddet (alıcı) ya da iptal et (gönderen)
    const q = db.requests.find(x => x.id === req.params.id && (x.to === req.u.id || x.from === req.u.id));
    if (!q) return fail(res, 404, 'İstek bulunamadı.');
    db.requests = db.requests.filter(x => x !== q); save();
    toUser(q.from, 'social:friends', {}); toUser(q.to, 'social:friends', {});
    res.json({ rel: 'none' });
  });
  r.delete('/friends/:username', (req, res) => {
    const o = byName(req.params.username);
    if (!o || !isFriend(req.u.id, o.id)) return fail(res, 404, 'Arkadaş bulunamadı.');
    db.friends[req.u.id] = (db.friends[req.u.id] || []).filter(x => x !== o.id);
    db.friends[o.id] = (db.friends[o.id] || []).filter(x => x !== req.u.id);
    delete db.messages[pairKey(req.u.id, o.id)]; save();
    toUser(o.id, 'social:friends', {}); toUser(req.u.id, 'social:friends', {});
    res.json({ rel: 'none' });
  });

  // Mesajlar (geçmiş + soket yoksa gönderme yedeği)
  r.get('/messages/:username', (req, res) => {
    const o = byName(req.params.username);
    if (!o || !isFriend(req.u.id, o.id)) return fail(res, 403, 'Bu kullanıcıyla arkadaş değilsiniz.');
    const before = Number(req.query.before) || Infinity;
    const rows = thread(req.u.id, o.id).filter(m => m.at < before);
    const slice = rows.slice(-50);
    if (!req.query.before) markRead(req.u, o);
    res.json({ messages: slice.map(m => msgOut(m)), more: rows.length > slice.length });
  });
  r.post('/messages/:username', (req, res) => {
    const out = sendDm(req.u, req.params.username, (req.body || {}).text, (req.body || {}).cid);
    if (out.error) return fail(res, 400, out.error);
    res.json(out);
  });

  r.use((err, req, res, next) => {                           // gövde çok büyük / hatalı istek
    res.status(err.status || 400).json({ error: err.type === 'entity.too.large' ? 'Fotoğraf çok büyük.' : 'İstek hatalı.' });
  });
  app.use('/api/social', r);

  // ---------- Soket: canlı mesajlaşma, yazıyor göstergesi, çevrimiçi durumu ----------
  io.on('connection', socket => {
    const u = socket.data.user;
    if (!u) return;
    socket.join('u:' + u.id);
    if (io.sockets.adapter.rooms.get('u:' + u.id).size === 1) toFriends(u.id, 'social:presence', { username: uname(u), online: true });

    socket.on('dm:send', (p = {}, cb = () => {}) => cb(sendDm(u, p.to, p.text, p.cid)));
    socket.on('dm:typing', (p = {}) => {
      const o = byName(p.to);
      if (o && isFriend(u.id, o.id) && !limited('ty:' + u.id, 30, 10000)) toUser(o.id, 'dm:typing', { from: uname(u), typing: !!p.typing });
    });
    socket.on('dm:read', (p = {}, cb = () => {}) => {
      const o = byName(p.with);
      cb({ ok: !!o && isFriend(u.id, o.id) && markRead(u, o) >= 0 });
    });
    socket.on('disconnect', () => {
      const room = io.sockets.adapter.rooms.get('u:' + u.id);
      if (!room || room.size === 0) toFriends(u.id, 'social:presence', { username: uname(u), online: false });
    });
  });
};
