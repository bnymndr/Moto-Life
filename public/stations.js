// Radyo istasyonları (türe göre). Yeni istasyon eklemek için ilgili türün listesine { name, url } satırı ekle.
// Adresler https olmalı (site https'te açıldığında http akışlar tarayıcı tarafından engellenir).
// İçi boş türler ekranda görünmez.
//
// SomaFM: reklamsız, dinleyici destekli, ücretsiz internet radyosu (resmi doğrudan akış adresleri).
// Jamendo: Creative Commons lisanslı bağımsız sanatçı müzikleri.
const SOMA = id => 'https://ice.somafm.com/' + id;

const STATIONS = [
  // --- TÜRKÇE YAYINLAR ---
  // Doğrulanmış, doğrudan çalan (mp3/aac, https) bir akış adresi bulduğunda şu şekilde ekle:
  { category: 'Türkçe Pop', stations: [
    // { name: 'Radyo Adı', url: 'https://ornek.com/yayin.mp3' },
  ]},
  { category: 'Türkçe Rap', stations: [
    // { name: 'Radyo Adı', url: 'https://ornek.com/yayin.mp3' },
  ]},
  { category: 'Türkü ve Nostalji', stations: [
    // { name: 'Radyo Adı', url: 'https://ornek.com/yayin.mp3' },
  ]},

  // --- YABANCI YAYINLAR ---
  { category: 'Hip-Hop / Rap', stations: [
    { name: 'Fluid – enstrümantal hip-hop', url: SOMA('fluid') },
  ]},
  { category: 'Elektronik', stations: [
    { name: 'Beat Blender – deep house', url: SOMA('beatblender') },
    { name: 'The Trip – progressive house', url: SOMA('thetrip') },
    { name: 'Dub Step Beyond – dubstep', url: SOMA('dubstep') },
  ]},
  { category: 'Chill', stations: [
    { name: 'Groove Salad – chill, downtempo', url: SOMA('groovesalad') },
    { name: 'Drone Zone – ambient', url: SOMA('dronezone') },
    { name: 'Lush – yumuşak vokaller', url: SOMA('lush') },
  ]},
  { category: 'Rock ve Retro', stations: [
    { name: 'Indie Pop Rocks! – indie rock', url: SOMA('indiepop') },
    { name: 'Metal Detector – metal', url: SOMA('metal') },
    { name: 'Left Coast 70s – 70\'ler rock', url: SOMA('seventies') },
    { name: 'Underground 80s – 80\'ler new wave', url: SOMA('u80s') },
    { name: 'Radio Paradise – karışık', url: 'https://stream.radioparadise.com/mp3-128' },
  ]},
  { category: 'Caz ve Soul', stations: [
    { name: 'Sonic Universe – modern caz', url: SOMA('sonicuniverse') },
    { name: 'Seven Inch Soul – klasik soul', url: SOMA('7soul') },
  ]},
  { category: 'Dünya ve Reggae', stations: [
    { name: 'Heavyweight Reggae – reggae, ska', url: SOMA('reggae') },
    { name: 'Suburbs of Goa – world beats', url: SOMA('suburbsofgoa') },
  ]},
  { category: 'Telifsiz (Creative Commons)', stations: [
    { name: 'Jamendo – En iyiler', url: 'https://streaming.jamendo.com/JamBestOf' },
    { name: 'Jamendo – Elektronik', url: 'https://streaming.jamendo.com/JamElectro' },
    { name: 'Jamendo – Rock', url: 'https://streaming.jamendo.com/JamRock' },
  ]},
];
