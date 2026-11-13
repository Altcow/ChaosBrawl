import { Loop } from './core/loop.js';
import { Input } from './core/input.js';
import { createWorld, stepWorld } from './sim/world.js';
import { layoutSpawns } from './sim/modes.js';
import { commandMacro } from './sim/command.js';
import { Renderer } from './render/renderer.js';
import { setupTouch } from './ui/touch.js';
import { setupMenu } from './ui/select.js';
import { setupRoom } from './ui/room.js';

// 練習場景:木樁 / 簡易對手
const SCENARIOS = [['post'], ['post', 'post', 'post'], ['post', 'puncher'], ['puncher']];
const SEED = 20261113;

const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);

let chars = null;
let stage = null;
let world = null;
let cfg = null;
let srcOf = []; // 每個角色對應的本機輸入來源(只有真人有)
let scn = Math.min(SCENARIOS.length - 1, Math.max(0, parseInt(qs.get('s') || '0', 10) || 0));
let started = false;
let menu = null;
let room = null;
let online = null; // 連線中的 Session

const input = new Input();
input.attach();
const renderer = new Renderer($('game'));
const touch = setupTouch($('touch'), input, assist);

function assist() {
  let w = world;
  let i = srcOf.indexOf('P1');
  if (online) {
    w = online.role === 'host' ? online.world : online.pw;
    i = online.fid;
  }
  if (!w || i < 0) return;
  const f = w.fighters[i];
  const cmd = w.defs[f.charId].assist;
  if (cmd) input.queueMacro('P1', commandMacro(cmd, f.face));
}

function buildWorld() {
  if (!cfg) return;
  const spawns = [];
  srcOf = [];
  if (cfg.mode === 'practice') {
    const s0 = cfg.slots[0];
    spawns.push({ charId: s0.char, kind: 'human', x: 400, z: 110, face: 1 });
    srcOf.push(/^(P|G)/.test(s0.kind) ? s0.kind : 'P1');
    SCENARIOS[scn].forEach((kind, i) => {
      spawns.push({ charId: s0.char, kind, x: 520 + i * 110, z: 60 + ((i * 50) % 120) + 30, face: -1, period: 30 });
      srcOf.push(null);
    });
  } else {
    const active = cfg.slots.filter((s) => s.kind !== 'off');
    const lay = layoutSpawns(active.length, stage);
    active.forEach((s, i) => {
      const human = /^(P|G)/.test(s.kind);
      spawns.push({ charId: s.char, kind: human ? 'human' : 'ai', lvl: human ? 0 : parseInt(s.kind.slice(2), 10), team: cfg.mode === 'team' ? s.team : i, x: lay[i].x, z: lay[i].z, face: lay[i].face });
      srcOf.push(human ? s.kind : null);
    });
  }
  world = createWorld({ chars, seed: SEED, stage, spawns, mode: cfg.mode, ff: cfg.ff || 0 });
  renderer.capturePrev(world);
  renderer.fx.clear();
  renderer.zoom = 1;
}

function step() {
  if (online) {
    online.tick(input.read('P1'));
    return;
  }
  renderer.capturePrev(world);
  const inputs = world.fighters.map((f, i) => (f.kind === 'human' ? input.read(srcOf[i]) : 0));
  stepWorld(world, inputs);
  for (const e of world.events) renderer.fx.add(e);
  renderer.fx.tick();
}

const nameOf = (i) => '#' + (i + 1) + ' ' + world.defs[world.fighters[i].charId].name;
const loop = new Loop(step, (alpha) => {
  if (online) {
    const v = online.view();
    if (v) renderer.draw(v, 1, loop, [online.fid], (i) => (online.cfg.seats[i].name || '#' + (i + 1)));
    return;
  }
  if (!world) return;
  const focus = world.fighters.map((f, i) => (f.kind === 'human' ? i : -1)).filter((i) => i >= 0);
  renderer.draw(world, alpha, loop, focus, nameOf);
});

function updatePause() {
  const portrait = window.matchMedia('(orientation: portrait)').matches;
  const paused = !started || portrait || document.hidden;
  if (paused !== loop.paused) {
    loop.setPaused(paused);
    input.clear();
    touch.reset();
  }
}

async function enterFullscreen() {
  try {
    if (document.documentElement.requestFullscreen && !document.fullscreenElement) await document.documentElement.requestFullscreen({ navigationUI: 'hide' });
  } catch (e) { /* 不支援或被拒絕 */ }
  try {
    if (screen.orientation && screen.orientation.lock) await screen.orientation.lock('landscape');
  } catch (e) { /* iOS Safari 不支援 */ }
  try {
    if (navigator.wakeLock) await navigator.wakeLock.request('screen');
  } catch (e) { /* 不支援 */ }
}

function start(c) {
  const active = c.slots.filter((s) => s.kind !== 'off').length;
  if (c.mode !== 'practice' && active < 2) {
    alert('至少需要 2 個座位');
    return;
  }
  cfg = c;
  buildWorld();
  menu.hide();
  started = true;
  updatePause();
  if (!qs.has('nofs')) enterFullscreen();
}

function startOnline(sess) {
  online = sess;
  world = null;
  renderer.prev = [];
  renderer.fx.clear();
  renderer.zoom = 1;
  sess.onFx = (evs) => { for (const e of evs) renderer.fx.add(e); };
  menu.hide();
  started = true;
  updatePause();
  if (!qs.has('nofs')) enterFullscreen();
}

function toMenu() {
  if (online) {
    online.stop();
    online = null;
  }
  started = false;
  menu.show();
  updatePause();
}

async function boot() {
  const ids = await (await fetch('data/chars/index.json')).json();
  chars = {};
  for (const id of ids) chars[id] = await (await fetch('data/chars/' + id + '.json')).json();
  stage = await (await fetch('data/stages/market.json')).json();
  menu = setupMenu($('menu'), ids.map((id) => ({ id, name: chars[id].name })), start);
  room = setupRoom($('menu'), { chars, stage, charIds: ids, getMode: () => $('sel-mode').value, onSession: startOnline });
  room.rejoin();

  const hasTouch = qs.has('touch') || 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  if (hasTouch) touch.show();
  if (qs.has('debug')) setDebug(true);

  $('btn-debug').addEventListener('click', () => setDebug(!renderer.debug));
  $('btn-reset').addEventListener('click', () => { if (!online) buildWorld(); });
  $('btn-menu').addEventListener('click', toMenu);
  $('btn-scn').addEventListener('click', () => { scn = (scn + 1) % SCENARIOS.length; buildWorld(); });
  window.addEventListener('keydown', (e) => {
    if (!started || online && e.code !== 'KeyB' && e.code !== 'Enter') return;
    if (e.code === 'KeyB') setDebug(!renderer.debug);
    else if (e.code === 'KeyR') buildWorld();
    else if (e.code === 'KeyN' && cfg.mode === 'practice') { scn = (scn + 1) % SCENARIOS.length; buildWorld(); }
    else if (e.code === 'Enter') toMenu();
  });

  window.addEventListener('resize', () => renderer.resize());
  window.addEventListener('orientationchange', () => renderer.resize());
  document.addEventListener('visibilitychange', updatePause);
  window.matchMedia('(orientation: portrait)').addEventListener('change', () => { renderer.resize(); updatePause(); });
  // 禁止縮放、長按選單、雙擊放大
  document.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  document.addEventListener('dblclick', (e) => e.preventDefault());
  document.addEventListener('touchmove', (e) => { if (e.touches.length > 1) e.preventDefault(); }, { passive: false });

  renderer.resize();
  updatePause();
  loop.start();

  const dev = location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if ('serviceWorker' in navigator && (!dev || qs.has('sw'))) navigator.serviceWorker.register('sw.js').catch(() => {});

  // 測試用把手
  window.__cb = { get world() { return world; }, input, loop, renderer, start, buildWorld, touch, menu, toMenu, startOnline };
}

function setDebug(on) {
  renderer.debug = on;
  $('btn-debug').classList.toggle('on', on);
}

boot();
