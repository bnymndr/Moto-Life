// Sinyalleşme sunucusu: sesin kendisi sunucudan geçmez (WebRTC peer-to-peer).
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');

const MAX_PER_ROOM = 6;               // mesh yapısında 6 kişiye kadar rahat çalışır
const MAX_ROOMS = 200;
const ROOM_GRACE_MS = 10 * 60 * 1000; // boş kalan grup 10 dk sonra silinir
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// anahtar (küçük harfli grup adı) -> { name, salt, hash, radio, emptySince }
// Şifreler düz metin saklanmaz; yalnızca scrypt özeti tutulur. Her şey bellekte, sunucu yeniden başlarsa gruplar silinir.
const rooms = new Map();

app.use(express.static(path.join(__dirname, 'public')));

const clean = (s, n) => String(s || '').trim().slice(0, n);
const validUrl = u => typeof u === 'string' && /^https?:\/\//i.test(u) && u.length < 500;
const sioRoom = key => 'room:' + key; // soket kimlikleriyle karışmasın diye önek
const members = key => io.sockets.adapter.rooms.get(sioRoom(key))?.size || 0;
const hashPw = (pw, salt) => crypto.scryptSync(pw, salt, 32);
const checkPw = (room, pw) => crypto.timingSafeEqual(hashPw(String(pw || ''), room.salt), room.hash);

// Bekleyen "gruba paylaş" isteği sahibi geri çekilince grup sahibinin ekranından kaldırılır
function dropPending(r, id) {
  if (r.pending.delete(id)) io.sockets.sockets.get(r.ownerId)?.emit('radio-request-cancel', { id });
}
const gs = r => ({ locked: !!r.locked, max: r.max || MAX_PER_ROOM, allowReq: r.allowReq !== false });
const listRooms = () => [...rooms.entries()]
  .map(([key, r]) => ({ key, name: r.name, count: members(key), max: r.max || MAX_PER_ROOM, locked: !!r.locked }))
  .sort((a, b) => a.name.localeCompare(b.name, 'tr'));
const broadcastRooms = () => io.emit('rooms', listRooms());

function enterRoom(socket, key, name, cb) {
  const r = rooms.get(key), max = r.max || MAX_PER_ROOM;
  if (members(key) >= max) return cb({ error: `Grup dolu (en fazla ${max} kişi).` });
  const uid = socket.data.user.id;   // kilitli grupta daha önce katılmış olanlar tekrar girebilir
  if (r.locked && !(r.known && r.known.has(uid))) return cb({ error: 'Bu grup yeni üyelere kapalı.' });
  (r.known = r.known || new Set()).add(uid);

  const ids = [...(io.sockets.adapter.rooms.get(sioRoom(key)) || [])];
  socket.data.room = key;
  socket.data.name = uname(socket.data.user);
  socket.join(sioRoom(key));
  const acct = socket.data.user;   // katıldığı grupları hesabına işle (en yeni başta, en fazla 10)
  acct.groups = [{ key, name: r.name, at: Date.now() }, ...(acct.groups || []).filter(g => g.key !== key)].slice(0, 10);
  saveUsers();
  r.emptySince = 0;
  if (!r.ownerId) r.ownerId = socket.id; // grup boşalmışsa giren ilk kişi sahip olur

  const peers = ids.map(id => {
    const d = io.sockets.sockets.get(id)?.data || {};
    return { id, name: d.name || 'Sürücü', mic: d.mic !== false, spk: d.spk !== false };
  });
  cb({ room: r.name, peers, radio: r.radio, ownerId: r.ownerId, gset: gs(r) });
  socket.to(sioRoom(key)).emit('peer-joined', { id: socket.id, name: socket.data.name });
  broadcastRooms();
}

// ================= Hesaplar: uygulamaya özel üyelik =================
// Hesaplar data/users.json dosyasında tutulur (şifreler scrypt özeti). Oturum imzalı çerezle sürer.
const fs = require('fs');
let nodemailer = null;
try { nodemailer = require('nodemailer'); } catch {}
const DATA_DIR = path.join(__dirname, 'data');
fs.mkdirSync(DATA_DIR, { recursive: true });
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const users = new Map();
try { for (const u of JSON.parse(fs.readFileSync(USERS_FILE, 'utf8'))) users.set(u.id, u); } catch {}
const saveUsers = () => {
  fs.writeFileSync(USERS_FILE + '.tmp', JSON.stringify([...users.values()]));
  fs.renameSync(USERS_FILE + '.tmp', USERS_FILE);
};
// Geçmiş grup kaydı tutulmaz: açılışta eski kayıtlar silinir, grup kapanınca herkesin kaydından düşer
for (const u of users.values()) delete u.groups;
saveUsers();
const dropGroupRecords = key => {
  let changed = false;
  for (const u of users.values()) {
    if (u.groups && u.groups.some(g => g.key === key)) { u.groups = u.groups.filter(g => g.key !== key); changed = true; }
  }
  if (changed) saveUsers();
};
const SECRET_FILE = path.join(DATA_DIR, 'secret.txt');
const SECRET = process.env.SESSION_SECRET || (() => {
  try { return fs.readFileSync(SECRET_FILE, 'utf8'); } catch {}
  const s = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(SECRET_FILE, s);
  return s;
})();
// Şifre sıfırlama e-postası için SMTP (isteğe bağlı; tanımlı değilse bağlantı sunucu konsoluna yazılır)
const SMTP_HOST = process.env.SMTP_HOST || '';
const SMTP_PORT = Number(process.env.SMTP_PORT || 587);
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const MAIL_FROM = process.env.MAIL_FROM || SMTP_USER;
const APP_URL = (process.env.APP_URL || '').replace(/\/+$/, '');

// Profil fotoğrafı: istemci 192x192 JPEG olarak küçültüp gönderir
app.post('/api/avatar', express.json({ limit: '200kb' }), (req, res) => {
  const u = userFromCookie(req.headers.cookie);
  if (!u) return res.status(401).json({ error: 'Giriş gerekli.' });
  const img = String((req.body || {}).image || '');
  if (img.length > 90000 || !/^data:image\/jpeg;base64,[A-Za-z0-9+/=]+$/.test(img)) {
    return res.status(400).json({ error: 'Fotoğraf geçersiz ya da çok büyük.' });
  }
  u.avatar = img;
  saveUsers();
  res.json({ user: pub(u) });
});

app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });

const GENDERS = ['erkek', 'kadin', 'belirtmek-istemiyorum'];
const EMAIL_RE = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;
const USER_RE = /^[A-Za-z0-9_.]{3,20}$/;
const sign = v => crypto.createHmac('sha256', SECRET).update(v).digest('base64url');
const uname = u => u.username || u.name || 'Sürücü';   // eski hesaplar için
const pub = u => ({
  username: uname(u), firstName: u.firstName || '', lastName: u.lastName || '',
  gender: u.gender || 'belirtmek-istemiyorum', bikeBrand: u.bikeBrand || '', bikeModel: u.bikeModel || '',
  email: u.email || '', hasPassword: !!u.hash,
  avatar: u.avatar || '', groups: (u.groups || []).filter(g => rooms.has(g.key)).map(g => ({ key: g.key, name: g.name }))
});
const findByEmail = e => e && [...users.values()].find(u => u.email === e);
const findByUsername = n => [...users.values()].find(u => uname(u).toLowerCase() === String(n).toLowerCase());
const findByLogin = k => findByEmail(k.toLowerCase()) || findByUsername(k);
const setPassword = (u, pw) => { const salt = crypto.randomBytes(16); u.salt = salt.toString('hex'); u.hash = hashPw(pw, salt).toString('hex'); };
const checkPassword = (u, pw) => !!u.hash && crypto.timingSafeEqual(hashPw(String(pw || ''), Buffer.from(u.salt, 'hex')), Buffer.from(u.hash, 'hex'));

function setSessionCookie(req, res, u) {
  const exp = Date.now() + 30 * 864e5, v = u.id + '.' + exp + '.' + (u.sv || 0);
  res.setHeader('Set-Cookie', `sid=${v}.${sign(v)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${30 * 86400}${req.secure ? '; Secure' : ''}`);
}
function startSession(req, res, u) { setSessionCookie(req, res, u); res.json({ user: pub(u) }); }
function userFromCookie(header) {
  const m = /(?:^|;\s*)sid=([^;]+)/.exec(header || '');
  if (!m) return null;
  const parts = m[1].split('.');
  if (parts.length !== 4) return null;
  const [uid, exp, sv, mac] = parts;
  if (Number(exp) < Date.now()) return null;
  const a = Buffer.from(sign([uid, exp, sv].join('.'))), b = Buffer.from(mac);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
  const u = users.get(uid);
  return u && (u.sv || 0) === Number(sv) ? u : null;       // şifre değişince eski oturumlar düşer
}

// Yanlış şifre denemelerini IP başına sınırla
const fails = new Map();
const isLocked = ip => (fails.get(ip)?.until || 0) > Date.now();
const addFail = ip => {
  const f = fails.get(ip) || { n: 0, until: 0 };
  if (++f.n >= 5) { f.until = Date.now() + 60000; f.n = 0; }
  fails.set(ip, f);
};

function readProfile(b) {
  const f = {
    username: clean(b.username, 20), firstName: clean(b.firstName, 40), lastName: clean(b.lastName, 40),
    gender: String(b.gender || ''), bikeBrand: clean(b.bikeBrand, 40), bikeModel: clean(b.bikeModel, 40),
    email: clean(b.email, 120).toLowerCase()
  };
  if (!USER_RE.test(f.username)) return { error: 'Kullanıcı adı 3-20 karakter olmalı (harf, rakam, _ ve . kullanılabilir).' };
  if (!f.firstName) return { error: 'İsmini gir.' };
  if (!f.lastName) return { error: 'Soyismini gir.' };
  if (!GENDERS.includes(f.gender)) return { error: 'Cinsiyet seç.' };
  if (!f.bikeBrand) return { error: 'Motosiklet markasını gir.' };
  if (!f.bikeModel) return { error: 'Motosiklet modelini gir.' };
  if (!EMAIL_RE.test(f.email)) return { error: 'Geçerli bir e-posta gir.' };
  return { f };
}

async function sendMail(to, subject, text) {
  if (!SMTP_HOST || !nodemailer) {
    console.log(`\n[E-POSTA] SMTP tanımlı değil, mesaj gönderilmedi.\nKime: ${to}\nKonu: ${subject}\n${text}\n`);
    return;
  }
  const tr = nodemailer.createTransport({
    host: SMTP_HOST, port: SMTP_PORT, secure: SMTP_PORT === 465,
    auth: SMTP_USER ? { user: SMTP_USER, pass: SMTP_PASS } : undefined
  });
  await tr.sendMail({ from: MAIL_FROM, to, subject, text });
}


// --- Güvenlik doğrulaması: iki sayının toplamı. Soru sunucuda üretilir; jeton imzalı, tek kullanımlık ve süreli.
// Cevap jetonda düz yazılmaz (yalnızca imzanın içine girer). Tarayıcı soruyu kısa aralıklarla yeniler; sunucu 3 dk tolerans tanır.
const CAPTCHA_TTL = 3 * 60 * 1000, usedCaptcha = new Map(), captchaAsk = new Map();
const rnd = n => crypto.randomBytes(1)[0] % n;                 // eski Node sürümlerinde de çalışır
app.get('/api/captcha', (req, res) => {
  const now = Date.now();
  let r = captchaAsk.get(req.ip); if (!r || r.reset < now) r = { n: 0, reset: now + 60000 };
  captchaAsk.set(req.ip, r);
  if (++r.n > 60) return res.status(429).json({ error: 'Çok fazla soru istendi. Biraz bekle.' });
  const a = 2 + rnd(8), b = 2 + rnd(8), id = crypto.randomBytes(8).toString('hex'), exp = now + CAPTCHA_TTL;
  res.json({ a, b, token: [id, exp, sign(['cap', id, exp, a + b].join('|'))].join('.') });
});
function checkCaptcha(b) {
  if (b.website) return false;                                 // gizli tuzak alanı: insanlar görmez, botlar doldurur
  const p = String(b.captchaToken || '').split('.'), ans = String(b.captchaAnswer || '').trim();
  if (p.length !== 3 || !/^\d{1,3}$/.test(ans)) return false;
  const [id, exp, sig] = p;
  if (!/^[0-9a-f]{16}$/.test(id) || !/^\d{13}$/.test(exp) || !(+exp > Date.now()) || usedCaptcha.has(id)) return false;
  const want = sign(['cap', id, exp, String(parseInt(ans, 10))].join('|'));
  usedCaptcha.set(id, +exp);                                   // doğru ya da yanlış, bir soru yalnızca bir kez denenebilir
  return sig.length === want.length && crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(want));
}
setInterval(() => {
  const now = Date.now();
  for (const [k, e] of usedCaptcha) if (e < now) usedCaptcha.delete(k);
  for (const [k, r] of captchaAsk) if (r.reset < now) captchaAsk.delete(k);
}, 60000).unref();
const CAPTCHA_ERR = 'Güvenlik sorusunun cevabı yanlış ya da süresi dolmuş. Yeni soruyu cevapla.';

app.get('/api/me', (req, res) => {
  const u = userFromCookie(req.headers.cookie);
  u ? res.json({ user: pub(u) }) : res.status(401).json({ error: 'Giriş gerekli.' });
});

app.post('/api/register', (req, res) => {
  const b = req.body || {}, { f, error } = readProfile(b), pw = String(b.password || '');
  if (!checkCaptcha(b)) return res.status(400).json({ error: CAPTCHA_ERR });
  if (error) return res.status(400).json({ error });
  if (pw.length < 6 || pw.length > 64) return res.status(400).json({ error: 'Şifre 6-64 karakter olmalı.' });
  if (findByUsername(f.username)) return res.status(409).json({ error: 'Bu kullanıcı adı alınmış.' });
  if (findByEmail(f.email)) return res.status(409).json({ error: 'Bu e-posta ile zaten bir hesap var.' });
  const u = { id: crypto.randomBytes(12).toString('hex'), ...f, sv: 0, createdAt: Date.now() };
  setPassword(u, pw);
  users.set(u.id, u); saveUsers();
  startSession(req, res, u);
});

app.post('/api/login', (req, res) => {
  if (isLocked(req.ip)) return res.status(429).json({ error: 'Çok fazla yanlış deneme. 1 dakika bekle.' });
  const b = req.body || {};
  if (!checkCaptcha(b)) return res.status(400).json({ error: CAPTCHA_ERR });
  const u = findByLogin(clean(b.login, 120));
  if (!u || !checkPassword(u, b.password)) { addFail(req.ip); return res.status(401).json({ error: 'Kullanıcı adı / e-posta veya şifre hatalı.' }); }
  startSession(req, res, u);
});

// Hesap ayarları: profil, e-posta, şifre güncelleme
app.post('/api/account', (req, res) => {
  const u = userFromCookie(req.headers.cookie);
  if (!u) return res.status(401).json({ error: 'Giriş gerekli.' });
  const b = req.body || {}, { f, error } = readProfile({ ...pub(u), ...b });
  if (error) return res.status(400).json({ error });
  const byName = findByUsername(f.username), byMail = findByEmail(f.email);
  if (byName && byName.id !== u.id) return res.status(409).json({ error: 'Bu kullanıcı adı alınmış.' });
  if (byMail && byMail.id !== u.id) return res.status(409).json({ error: 'Bu e-posta başka bir hesapta kullanılıyor.' });
  const newPw = b.newPassword === undefined ? '' : String(b.newPassword);
  if (newPw && (newPw.length < 6 || newPw.length > 64)) return res.status(400).json({ error: 'Yeni şifre 6-64 karakter olmalı.' });
  if (u.hash && (f.email !== u.email || newPw)) {          // hassas değişiklikte mevcut şifre şart
    if (isLocked(req.ip)) return res.status(429).json({ error: 'Çok fazla yanlış deneme. 1 dakika bekle.' });
    if (!checkPassword(u, b.currentPassword)) { addFail(req.ip); return res.status(401).json({ error: 'Mevcut şifre hatalı.' }); }
  }
  Object.assign(u, f);
  if (newPw) { setPassword(u, newPw); u.sv = (u.sv || 0) + 1; setSessionCookie(req, res, u); }
  saveUsers();
  res.json({ user: pub(u) });
});

// Şifre unuttum: e-postaya tek kullanımlık, 30 dakika geçerli bağlantı gönder
const mailHits = new Map();
const sha = s => crypto.createHash('sha256').update(s).digest('hex');
app.post('/api/forgot', (req, res) => {
  const now = Date.now(), hits = (mailHits.get(req.ip) || []).filter(t => now - t < 600000);
  if (hits.length >= 5) return res.status(429).json({ error: 'Çok fazla istek. Biraz bekleyip tekrar dene.' });
  hits.push(now); mailHits.set(req.ip, hits);
  const u = findByEmail(clean((req.body || {}).email, 120).toLowerCase());
  if (u) {
    const token = crypto.randomBytes(32).toString('base64url');
    u.reset = { hash: sha(token), exp: now + 30 * 60000 };
    saveUsers();
    const link = `${APP_URL || req.protocol + '://' + req.get('host')}/?reset=${token}`;
    sendMail(u.email, 'Moto Life şifre sıfırlama',
      `Merhaba ${uname(u)},\n\nŞifreni sıfırlamak için bu bağlantıyı aç (30 dakika geçerli):\n${link}\n\nBu isteği sen yapmadıysan bu e-postayı yok sayabilirsin.`)
      .catch(e => console.error('E-posta gönderilemedi:', e.message));
  }
  res.json({ ok: true });   // e-posta kayıtlı olsa da olmasa da aynı yanıt
});
app.post('/api/reset', (req, res) => {
  const b = req.body || {}, pw = String(b.password || '');
  if (pw.length < 6 || pw.length > 64) return res.status(400).json({ error: 'Şifre 6-64 karakter olmalı.' });
  const h = sha(String(b.token || ''));
  const u = [...users.values()].find(x => x.reset && x.reset.hash === h && x.reset.exp > Date.now());
  if (!u) return res.status(400).json({ error: 'Bağlantı geçersiz ya da süresi dolmuş. Yeni bir bağlantı iste.' });
  setPassword(u, pw);
  delete u.reset;
  u.sv = (u.sv || 0) + 1;   // eski oturumları kapat
  saveUsers();
  res.json({ ok: true });
});

app.post('/api/logout', (req, res) => {
  res.setHeader('Set-Cookie', 'sid=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0');
  res.json({ ok: true });
});

// Soket bağlantısı yalnızca giriş yapmış kullanıcılara açık; görünen ad kullanıcı adıdır
io.use((socket, next) => {
  const u = userFromCookie(socket.handshake.headers.cookie);
  if (!u) return next(new Error('unauthorized'));
  socket.data.user = u;
  next();
});

io.on('connection', socket => {
  socket.emit('rooms', listRooms());

  // Yeni grup aç: ilk açan grup adını ve şifreyi belirler
  socket.on('create', ({ room, password, name } = {}, cb = () => {}) => {
    if (socket.data.room) return cb({ error: 'Zaten bir gruptasın.' });
    const display = clean(room, 32);
    const key = display.toLowerCase();
    const pw = String(password || '');
    if (!display) return cb({ error: 'Bir grup adı gir.' });
    if (pw.length < 4 || pw.length > 64) return cb({ error: 'Şifre 4-64 karakter olmalı.' });
    if (rooms.has(key)) return cb({ error: 'Bu grup adı zaten kullanımda.' });
    if (rooms.size >= MAX_ROOMS) return cb({ error: 'Çok fazla grup açık, biraz sonra dene.' });

    const salt = crypto.randomBytes(16);
    rooms.set(key, { name: display, salt, hash: hashPw(pw, salt), radio: null, emptySince: 0, ownerId: socket.id, pending: new Map() });
    enterRoom(socket, key, name, cb);
  });

  // Var olan gruba şifreyle katıl
  socket.on('join', ({ room, password, name } = {}, cb = () => {}) => {
    if (socket.data.room) return cb({ error: 'Zaten bir gruptasın.' });
    const now = Date.now();
    if ((socket.data.lockUntil || 0) > now) return cb({ error: 'Çok fazla yanlış deneme. 30 saniye bekle.' });

    const key = clean(room, 32).toLowerCase();
    const r = rooms.get(key);
    if (!r) return cb({ error: 'Böyle bir grup yok (kapanmış olabilir).' });
    if (!checkPw(r, password)) {
      socket.data.fails = (socket.data.fails || 0) + 1;
      if (socket.data.fails >= 5) { socket.data.lockUntil = now + 30000; socket.data.fails = 0; }
      return cb({ error: 'Şifre yanlış.' });
    }
    socket.data.fails = 0;
    enterRoom(socket, key, name, cb);
  });

  // SDP / ICE mesajlarını aynı gruptaki hedefe ilet
  socket.on('signal', ({ to, data } = {}) => {
    const target = io.sockets.sockets.get(to);
    if (target && socket.data.room && target.data.room === socket.data.room) {
      target.emit('signal', { from: socket.id, data });
    }
  });

  // Ortak radyo durumu
  // Grup radyosu: yalnızca grup sahibi ya da yayını başlatan değiştirebilir
  socket.on('radio', ({ url, name, playing } = {}, cb = () => {}) => {
    const key = socket.data.room;
    const r = key && rooms.get(key);
    if (!r || !validUrl(url)) return cb({ error: 'Geçersiz istek.' });
    const owner = r.ownerId === socket.id;
    if (!owner && !(r.radio && r.radio.by === socket.id)) {
      return cb({ error: 'Grup yayınını yalnızca grup sahibi ya da yayını başlatan kişi değiştirebilir.', radio: r.radio });
    }
    const by = owner && (!r.radio || r.radio.url !== url) ? socket.id : r.radio.by;
    r.radio = { url, name: clean(name, 80), playing: !!playing, by };
    socket.to(sioRoom(key)).emit('radio', r.radio);
    cb({ ok: true, radio: r.radio });
  });

  // Grup sahibi dışındakiler, dinlediği yayını gruba paylaşmak için onay ister
  socket.on('radio-request', ({ url, name } = {}, cb = () => {}) => {
    const key = socket.data.room;
    const r = key && rooms.get(key);
    if (!r || !validUrl(url)) return cb({ error: 'Geçersiz istek.' });
    if (r.ownerId === socket.id) return cb({ error: 'Grup sahibi onay almadan paylaşabilir.' });
    if (r.allowReq === false) return cb({ error: 'Grup sahibi paylaşım isteklerini kapattı.' });
    const ownerSock = io.sockets.sockets.get(r.ownerId);
    if (!ownerSock) return cb({ error: 'Grup sahibine ulaşılamadı.' });
    const req = { url, name: clean(name, 80) };
    r.pending.set(socket.id, req);
    ownerSock.emit('radio-request', { id: socket.id, user: socket.data.name, ...req });
    cb({ ok: true });
  });

  socket.on('radio-decision', ({ id, approve } = {}) => {
    const key = socket.data.room;
    const r = key && rooms.get(key);
    if (!r || r.ownerId !== socket.id) return;
    const req = r.pending.get(id);
    const target = io.sockets.sockets.get(id);
    r.pending.delete(id);
    if (!req || !target || target.data.room !== key) return;
    if (approve) {
      r.radio = { url: req.url, name: req.name, playing: true, by: id };
      io.to(sioRoom(key)).emit('radio', r.radio);
    }
    target.emit('radio-result', { approved: !!approve });
  });

  // Grup sahibi: bir katılımcıyı gruptan çıkar
  socket.on('kick', ({ id } = {}) => {
    const key = socket.data.room, r = key && rooms.get(key);
    if (!r || r.ownerId !== socket.id || id === socket.id) return;
    const target = io.sockets.sockets.get(id);
    if (!target || target.data.room !== key) return;
    target.emit('kicked');
    target.to(sioRoom(key)).emit('peer-left', target.id);
    target.leave(sioRoom(key));
    target.data.room = null;
    if (r.radio && r.radio.by === target.id) r.radio.by = null;
    dropPending(r, target.id);
    broadcastRooms();
  });

  // Grup sahibi: grubu kapat, herkesin bağlantısı kesilir
  socket.on('close-room', () => {
    const key = socket.data.room, r = key && rooms.get(key);
    if (!r || r.ownerId !== socket.id) return;
    const sr = sioRoom(key);
    for (const id of [...(io.sockets.adapter.rooms.get(sr) || [])]) {
      const s = io.sockets.sockets.get(id);
      if (s) s.data.room = null;
    }
    io.to(sr).emit('room-closed');
    io.in(sr).socketsLeave(sr);
    rooms.delete(key);
    dropGroupRecords(key);
    broadcastRooms();
  });

  // Mikrofon / hoparlör durumu: listede herkese gösterilir
  socket.on('status', ({ mic, spk } = {}) => {
    const key = socket.data.room;
    if (!key) return;
    socket.data.mic = mic !== false;
    socket.data.spk = spk !== false;
    socket.to(sioRoom(key)).emit('status', { id: socket.id, mic: socket.data.mic, spk: socket.data.spk });
  });

  // Grup sahibi ayarları: yeni üyelere kapatma, azami kişi, radyo paylaşım istekleri, şifre
  socket.on('group-settings', (b = {}, cb = () => {}) => {
    const key = socket.data.room, r = key && rooms.get(key);
    if (!r || r.ownerId !== socket.id) return cb({ error: 'Bu ayarı yalnızca grup sahibi değiştirebilir.' });
    let max = r.max || MAX_PER_ROOM, pw = null;
    if (b.max !== undefined) {
      max = Math.round(Number(b.max));
      if (!(max >= 2 && max <= MAX_PER_ROOM)) return cb({ error: `Kişi sayısı 2 ile ${MAX_PER_ROOM} arasında olmalı.` });
    }
    if (b.password !== undefined) {
      pw = String(b.password);
      if (pw.length < 4 || pw.length > 64) return cb({ error: 'Şifre 4-64 karakter olmalı.' });
    }
    r.max = max;
    if (b.locked !== undefined) r.locked = !!b.locked;
    if (b.allowReq !== undefined) {
      r.allowReq = !!b.allowReq;
      if (!r.allowReq) {   // bekleyen paylaşım isteklerini reddet
        for (const pid of r.pending.keys()) io.to(pid).emit('radio-result', { approved: false, reason: 'Grup sahibi paylaşım isteklerini kapattı.' });
        r.pending.clear();
      }
    }
    if (pw !== null) { const salt = crypto.randomBytes(16); r.salt = salt; r.hash = hashPw(pw, salt); }
    io.to(sioRoom(key)).emit('group-settings', gs(r));
    broadcastRooms();
    cb({ ok: true, settings: gs(r) });
  });

  socket.on('disconnecting', () => {
    const key = socket.data.room;
    if (!key) return;
    socket.to(sioRoom(key)).emit('peer-left', socket.id);
    setTimeout(() => {
      const r = rooms.get(key);
      if (r) {
        if (r.radio && r.radio.by === socket.id) r.radio.by = null; // yayını başlatan ayrıldı
        dropPending(r, socket.id);
        const left = [...(io.sockets.adapter.rooms.get(sioRoom(key)) || [])];
        if (!left.length) { r.emptySince = Date.now(); r.radio = null; r.ownerId = null; r.pending.clear(); }
        else if (r.ownerId === socket.id) { // sahip ayrıldı: en eski üye yeni sahip olur
          r.ownerId = left[0];
          for (const pid of r.pending.keys()) io.to(pid).emit('radio-result', { approved: false, reason: 'Grup sahibi değişti, isteği tekrar gönder.' });
          r.pending.clear();
          io.to(sioRoom(key)).emit('owner-changed', { id: left[0] });
        }
      }
      broadcastRooms();
    }, 0);
  });
});

// Uzun süredir boş kalan grupları sil
setInterval(() => {
  let changed = false;
  for (const [key, r] of rooms) {
    if (r.emptySince && Date.now() - r.emptySince > ROOM_GRACE_MS) { rooms.delete(key); dropGroupRecords(key); changed = true; }
  }
  if (changed) broadcastRooms();
}, 60 * 1000);

// Sosyal modül: profil, akış, arkadaşlık, canlı mesajlaşma
require('./social')({ app, io, users, userFromCookie, uname, dataDir: DATA_DIR });

// Harita servisleri: istemci yapılandırması, hedef arama, rota
require('./maps')({ app, userFromCookie });

// Sürüş kayıtları: yükleme (doğrulama + yeniden hesap), listeleme, okuma
require('./rides')({ app, express, userFromCookie, dataDir: DATA_DIR });

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Moto Interkom çalışıyor: http://localhost:${PORT}`));
