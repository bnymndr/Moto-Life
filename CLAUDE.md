# CLAUDE.md — Moto Life (moto-interkom)

Proje hafızası. Her oturumda önce bunu oku; bilgi burada varsa tekrar sorma. Gizli bilgi yazma.

## 1. Hedef
Motosiklet sürüşü, navigasyon ve topluluk platformu. Mevcut proje korunarak, küçük ve bağımsız aşamalarla geliştirilir (sıfırdan yazım yok).
Hedef modüller: canlı harita/navigasyon, sürüş ve performans ölçümleri, grup sürüşü + canlı takip, sürüş analiz ekranı.

## 2. Teknik altyapı
- Sunucu: Node >=18, Express 4, Socket.IO 4, nodemailer. Başlatma: `npm start` (`node server.js`).
- İstemci: tek dosya `public/index.html` (Tailwind CDN + saf JS). Sosyal ekran React 19 → esbuild ile `public/social.bundle.js` (`npm run build:social`).
- Veri: DB yok. JSON dosyaları `data/` altında; sürüşler `data/rides/<kullanıcı-id>/<sürüş-id>.json` (+ `.sum.json` özet). Gruplar yalnızca bellekte. İstemcide sürüşler IndexedDB (`motolife-rides`).
- Gerçek zamanlı: Socket.IO sinyalleşme + WebRTC mesh (en fazla 6 kişi). Ses sunucudan geçmez. ICE: yalnızca Google STUN (`index.html` ~satır 605).
- PWA: `public/manifest.webmanifest`, `public/sw.js`.
- Harita: Leaflet 1.9.4 (cdnjs, sabit sürüm; `public/map.js` yükler). Karolar OSM varsayılanı, sunucudan yapılandırılır.
- Ortam değişkenleri (değerleri kaydetme): `PORT`, `SESSION_SECRET`, `APP_URL`, `MAIL_FROM`, `SMTP_HOST/PORT/USER/PASS`, `ORS_API_KEY` (rota; yoksa rota kapalı), `MAP_TILE_URL`, `MAP_TILE_ATTRIBUTION`.
- Test betikleri: `yerel-test.bat`, `canli-test.bat` (cloudflared tüneli).

## 3. Önemli dosyalar
- `server.js` (~510 satır): hesaplar, oturum (imzalı çerez), captcha, şifre sıfırlama, grup/interkom/radyo soket olayları. `require('./social')` ile sosyal modülü bağlar.
- `social.js` (~340 satır): sosyal API ve DM (`data/social.json`, görseller `data/social-img/`).
- `src/SocialProfile.jsx`, `src/social.entry.jsx`: sosyal arayüz kaynağı. `build-social.js`: derleme.
- `public/index.html` (~1900 satır): tüm ekranlar (`<main id="dash|motor|world|friends|social|settings">`, `#tab-comm`, `#tab-radio`), alt gezinme `#bottomNav` (`data-nav`), ekran geçişi `showScreen`/`goTab` (~satır 1238-1250).
- `public/stations.js`: radyo istasyonu listesi.
- `maps.js`: `/api/maps/config`, `/api/geocode` (Nominatim proxy: 1 istek/sn kuyruk, önbellek, kullanıcı sınırı), `/api/route` (ORS `driving-car`, yalnızca anahtar varsa). `server.js` içinde tek `require` satırı.
- `public/map.js` + `public/map.css`: Harita ekranı (`window.MotoMap.mount/activate/deactivate/setRiders`). `index.html`'de `#world`→`#map-root`, `openMap()`, `showScreen` kancası, `#i-map` ikonu. Çekirdek hesaplar (`RideStats`, `RouteTracker`) Node ile test edilebilir.
- `public/ride-core.js`: sürüş kaydı çekirdeği (`Recorder`: başlat/duraklat/devam/bitir, GPS filtreleri, özet, `replay`, `validateRide`). İstemci VE sunucu aynı dosyayı kullanır; kuralı değiştirirsen ikisi birden değişir.
- `public/ride-store.js`: IndexedDB kalıcı kayıt (nokta başına yazım, anahtar = zaman damgası), bellek yedeği, çevrimdışı kuyruk, `sync()`.
- `rides.js`: `POST /api/rides` (octet-stream gövde, 3 MB; doğrula + özeti ham veriden yeniden hesapla; değişmez/idempotent), `GET /api/rides`, `GET /api/rides/:id`. `server.js`'de tek `require`.
- `data/users.json` (kullanıcılar, scrypt özeti), `data/secret.txt` (oturum anahtarı): **gizli, paylaşma, commit etme.**

## 4. Durum
Tamamlanan:
- Üyelik: kayıt/giriş, şifre sıfırlama, captcha, profil/avatar, motosiklet bilgisi (My Motor).
- İnterkom: şifreli grup, sahip yetkileri (atma/kilitleme/devir/silme), mic/hoparlör durumu, ortak radyo.
- Sosyal: akış, beğeni, yorum, arkadaşlık, arama, canlı DM.
- Diğer: izin ekranı, wake lock, ana ekran hava durumu, mobil uyum (safe-area, `100dvh`).
- Bireysel sürüş kaydı: başlat/duraklat/devam/bitir, anlık-ort.-maks. hız, mesafe, aktif/hareket/duruş süresi, iki ortalama hız (hareket ve toplam; panelde dokununca değişir), zaman damgalı ham GPS noktaları, cihaza anında kayıt, sayfa yenilenirse/kapanırsa kurtarma ("Yarım kalan sürüş"), çevrimdışı kuyruk + otomatik/elle eşitleme.
- Harita ekranı (alt gezinmede "Harita", eski "Açık Dünya" yuvası): canlı GPS konumu, yakınlaştır/uzaklaştır, konumuma dön, koyu/açık tema, hedef arama (düğmeyle), hedef kartı (kuş uçuşu mesafe), sürüş başlat/bitir (mesafe, süre, anlık/ort./maks. hız; özet), `setRiders()` işaret altyapısı, rota + kalan mesafe/ETA + sapınca yeniden hesaplama (ORS_API_KEY ile).

Yarım / yer tutucu: "Arkadaşlar" ekranı (boş). Rota yalnızca `ORS_API_KEY` tanımlıysa çalışır (yazıldı, gerçek ORS ile test EDİLMEDİ).

Hiç yok: sürüş geçmişi/analiz ekranı (kayıtlar `GET /api/rides` ile okunabilir), sensör verileri (ani fren/hızlanma, yatış, rakım), canlı konum paylaşımı, davet kodu/bağlantısı, grup sürüşü takibi, adım adım/sesli yönlendirme.

## 5. Bilinen sorunlar
1. İkon yolu: `index.html:8`, `manifest.webmanifest`, `sw.js:4` `/icons/...` bekliyor; dosyalar `public/` kökünde, `/icons` rotası yok → `addAll` hatası, service worker kurulumu düşebilir.
2. TURN yok → operatör ağlarında bağlantı kurulamayabilir.
3. Bağlantı kopunca otomatik toparlanma yok (`disconnect` yalnızca uyarı verir, ICE restart yok).
4. `.gitignore` yok; `data/` hassas veri içerir.
5. Sürüş kayıtları dosya tabanlı (`data/rides/`); binlerce sürüş/kullanıcıda dizin taraması ve liste yavaşlar → o zaman SQLite/indeks düşünülür. Cihazdaki eski sürüşler otomatik silinmez.
6. `index.html` tek dosya olarak büyüyor.
7. Harita: Leaflet cdnjs'ten yükleniyor (CDN'e bağımlı); ağ olan ortamda `public/vendor/`a taşınmalı. OSM karoları yoğun/yaygın dağıtım için uygun değil (karo sağlayıcısı gerekir). Ekran görüntüleri ve akış testleri sahte Leaflet ile yapıldı; gerçek harita çizimi, karolar, GPS ve dokunmatik kullanım gerçek cihazda doğrulanmadı.
8. Sürüş hızı: cihaz `coords.speed` vermezse konum farkından hesaplanır (daha dalgalı olabilir). Arka planda/ekran kilitliyken konum kesilir; kesintiler özetde belirtilir.

## 6. Teknik kararlar
- Mevcut mimari korunur: Express + Socket.IO, saf JS istemci, sosyal tarafta React paketi. Yeni kütüphane/ücretli servis yalnızca gerçekten gerekliyse.
- API anahtarları yalnızca sunucuda; istemciye gönderilmez, harita/rota servisleri gerekirse sunucudan proxy'lenir.
- Konum paylaşımı varsayılan kapalı, kullanıcı iznine bağlı; yetki (arkadaşlık/grup) sunucuda denetlenir.
- Sensör verileri ayrı etiketlenir: ölçülen / tahmini / desteklenmeyen. Yatış açısı "tahmini" gösterilir (montaj ve kalibrasyona bağlı).
- Sürüş verisi modeli: olaylar `[t, tür, n]` (n = o ana kadar saklanan nokta sayısı), noktalar `[t,lat,lon,acc,hız|null,bayrak]` (0 kabul, 1 zayıf doğruluk, 2 sıçrama, 3 yeni referans). Elenen noktalar da saklanır. Özet her zaman ham veriden `replay` ile hesaplanır; sunucu istemcinin özetine güvenmez. Duraklatma/boşluk sırasındaki yer değişimi mesafeye eklenmez.
- Filtre değerleri (`ride-core.js`): doğruluk >50 m elenir; fiziksel olarak mümkün olmayan yer değişimi (ivme 12 m/sn², 83 m/sn üstü) sıçrama sayılır, art arda 3 sıçrama yeni referans olur; >30 sn boşluk + >100 m sıçrama kesinti sayılır; <0,8 m/sn duruş sayılır; sınır 30000 nokta (~8 sa). Değerler gerçek sürüş verisiyle ayarlanmadı.
- PWA arka planda güvenilir konum kaydetmez; sürüşte wake lock ile ekran açık tutulur.
- Rota: ORS `driving-car`; arayüz "araç rotası, motosiklet için optimize değil" der. Google TWO_WHEELER Türkiye'de yok. Gerçek motosiklet profili ayrı karar (kendi sunucu/GraphHopper özel profil).
- Arama otomatik tamamlama yapmaz (Nominatim politikası); sonuç sunucuda önbelleklenir.
- Bekleyen kararlar (netleşmedi, varsayma): harita/rota servisi (ücretsiz OSM mi, ücretli mi), ikon düzeltme yönü, TURN sağlayıcısı.

## 7. Geliştirme sırası
1. Hazırlık: ikon yolu, `.gitignore` (YAPILMADI).
2. Harita + anlık konum + izin akışı (YAPILDI, cihazda doğrulanacak).
3. Sürüş kaydı: ölçüm, cihaza kayıt, kurtarma, sunucuya eşitleme YAPILDI (gerçek cihazda doğrulanacak). Sırada: geçmiş/analiz ekranı.
4. Hedef arama YAPILDI; rota kodu hazır, ORS anahtarı ve gerçek test bekliyor.
5. Sensör olayları (ani fren/hızlanma, yatış).
6. Canlı konum paylaşımı (gizlilik, mesafe filtresi).
7. Grup sürüşü (davet kodu, lider, geride kalan uyarısı).
8. Analiz ekranı (grafik, zaman çizelgesi, karşılaştırma).
Paralel: TURN ve bağlantı toparlanması, grup sürüşünden (7) önce.

## 8. Çalışma kuralları
- Önce ilgili dosyayı incele; varsayımla kod yazma. Var olan özelliği yeniden yazma.
- Tek seferde tek aşama; ilgisiz modüllere dokunma. Teknik engel varsa kod yazmadan önce engeli ve en ucuz çözümü bildir.
- Yalnızca değişen dosyalarda çalış; dosyaları baştan yazma, kodu sohbete dökme.
- Her değişiklikten sonra mevcut işlevlerin bozulmadığını kontrol et (en az `node --check`; sosyal kaynak değiştiyse `npm run build:social`).
- Sahte veriyi gerçekmiş gibi gösterme; gerçek cihazla test gerektiren şeyi "test edilmedi" diye belirt.
- Silme/taşıma/yeniden adlandırma ve `data/` içeriğini değiştirme: önce onay al.
- Arayüz: koyu lacivert (`#031420`) + turuncu (`#EA8621`) dili, mobil öncelikli, sürüşte büyük dokunma alanları, gereksiz animasyon yok.
- Yanıtlar kısa: yapılan değişiklik, etkilenen dosyalar, test sonucu. Aşama bitince bu dosyayı güncelle.
