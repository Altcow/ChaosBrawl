const VERSION = 16;
const CACHE = 'chaosbrawl-v' + VERSION;
const ASSETS = [
  './', './index.html', './manifest.webmanifest', './css/main.css',
  './js/main.js',
  './js/core/loop.js', './js/core/input.js', './js/core/rng.js', './js/core/fixed.js',
  './js/sim/world.js', './js/sim/fighter.js', './js/sim/command.js', './js/sim/hit.js', './js/sim/projectiles.js', './js/sim/ai.js', './js/sim/box.js', './js/sim/modes.js', './js/sim/ult.js',
  './js/render/renderer.js', './js/render/sprites.js', './js/render/fx.js', './js/render/hud.js', './js/render/debug.js', './js/render/ult.js',
  './js/ui/moves.js', './js/ui/tip.js', './js/ui/touch.js', './js/ui/select.js', './js/ui/room.js',
  './js/net/net.js', './js/net/fb.js', './js/net/mem.js', './js/net/codec.js', './js/net/config.js', './js/net/lobby.js', './js/net/sync.js', './js/net/migrate.js', './js/net/usage.js',
  './data/chars/index.json', './data/chars/fanfan.json', './data/chars/areh.json', './data/chars/guanyu.json', './data/chars/lubu.json', './data/chars/cilin.json', './data/chars/huhu.json', './data/chars/liushui.json', './data/chars/erhao.json', './data/chars/magnet.json', './data/chars/sun.json', './data/art/fanfan/atlas.json', './data/art/fanfan/atlas.png', './data/art/areh/atlas.json', './data/art/areh/atlas.png', './data/art/guanyu/atlas.json', './data/art/guanyu/atlas.png', './data/art/magnet/atlas.json', './data/art/magnet/atlas.png', './data/art/sun/atlas.json', './data/art/sun/atlas.png', './data/art/lubu/atlas.json', './data/art/lubu/atlas.png',
  './data/stages/market.json'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET') return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request)));
});
