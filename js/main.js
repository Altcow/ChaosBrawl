import { Loop } from './core/loop.js';
import { Input } from './core/input.js';
import { createWorld, stepWorld } from './sim/world.js';
import { layoutSpawns } from './sim/modes.js';
import { commandMacro } from './sim/command.js';
import { Renderer } from './render/renderer.js';
import { setupTouch } from './ui/touch.js';
import { setupHome } from './ui/select.js';
import { setupRoom } from './ui/room.js';
import { setupMoves, listMoves, cmdText, defaultDevice } from './ui/moves.js';
import { setupTip } from './ui/tip.js';
import { setHudHint } from './render/hud.js';

// 練習場景:木樁 / 簡易對手
const SCENARIOS = [['post'], ['post', 'post', 'post'], ['post', 'puncher'], ['puncher']];
const SEED = 20261113;
// 鏡頭縮放:基準 1.5(人物約 110 px 高),為了框住本機玩家可再縮小、不放大超過基準。
// 需要 render/renderer.js 讀取 zoomMax / zoomMin(見回報);沒支援時退回 renderer 內建的 0.6~1.0。
const CAM = { base: 1.5, min: 0.75 };

const $ = (id) => document.getElementById(id);
const qs = new URLSearchParams(location.search);

let chars = null;
let stage = null;
let world = null;
let cfg = null;
let srcOf = []; // 每個角色對應的本機輸入來源(只有真人有)
let scn = Math.min(SCENARIOS.length - 1, Math.max(0, parseInt(qs.get('s') || '0', 10) || 0));
let started = false;
let home = null;
let room = null;
let online = null; // 連線中的 Session
let movesPanel = null;
let movesOpen = false;
let tip = null;
let hasTouch = false;

const input = new Input();
input.attach();
const renderer = new Renderer($('game'));
const touch = setupTouch($('touch'), input, assist, specials);

// 本機 P1 玩家的角色(單機 / 連線通用);沒有時回傳 null
function myFighter() {
  let w = world;
  let i = srcOf.indexOf('P1');
  if (online) {
    w = online.role === 'host' ? online.world : online.pw;
    i = online.fid;
  }
  if (!w || i < 0 || !w.fighters[i]) return null;
  return { w, f: w.fighters[i] };
}

// 必殺鈕:cmd = 指定招式(面板點選);沒給 = 第一招(assist)
function assist(cmd) {
  const me = myFighter();
  if (!me) return;
  const c = cmd || me.w.defs[me.f.charId].assist;
  if (c) input.queueMacro('P1', commandMacro(c, me.f.face));
}

// 觸控必殺面板的資料:目前角色全部必殺(名稱 / 指令簡寫 / MP 消耗)與目前 MP
function specials() {
  const me = myFighter();
  if (!me || !chars) return null;
  const j = chars[me.f.charId];
  return { items: listMoves(j).map((m) => ({ cmd: m.cmd, name: m.name, short: cmdText(m.cmd, 'touch', true), cost: m.cost })), mp: me.f.mp };
}

// 招式表:遊戲中打開當前玩家角色;首頁依選定角色
function openMoves(charId, dev) {
  if (!movesPanel) return;
  const me = started ? myFighter() : null;
  const id = charId || (me ? me.f.charId : home.getPrefChar() === 'random' ? Object.keys(chars)[0] : home.getPrefChar());
  const src = srcOf.find((s) => s) || 'P1';
  movesPanel.open(id, dev || defaultDevice(src, hasTouch));
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
    const sides = cfg.mode === 'team' ? active.map((s) => s.team) : null; // 分隊戰:同隊站同側
    const lay = layoutSpawns(active.length, stage, sides);
    active.forEach((s, i) => {
      const human = /^(P|G)/.test(s.kind);
      spawns.push({ charId: s.char, kind: human ? 'human' : 'ai', lvl: human ? 0 : parseInt(s.kind.slice(2), 10), team: cfg.mode === 'team' ? s.team : i, x: lay[i].x, z: lay[i].z, face: lay[i].face });
      srcOf.push(human ? s.kind : null);
    });
  }
  world = createWorld({ chars, seed: SEED, stage, spawns, mode: cfg.mode, ff: cfg.ff || 0, ult: true });
  renderer.capturePrev(world);
  renderer.fx.clear();
  renderer.zoom = CAM.base;
  $('result').classList.add('hide');
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
let resultShown = false;
function showResult(over) {
  if (over === resultShown) return;
  resultShown = over;
  $('result').classList.toggle('hide', !over);
  $('btn-again').style.display = online ? 'none' : ''; // 連線局由房主在大廳重開,這裡只回首頁
}
const loop = new Loop(step, (alpha) => {
  if (online) {
    const v = online.view();
    if (v) {
      setHudHint([online.fid], hasTouch);
      renderer.draw(v, 1, loop, [online.fid], (i) => (online.cfg.seats[i].name || '#' + (i + 1)), (i) => (online.cfg.seats[i].name || v.defs[v.fighters[i].charId].name));
      const me = v.fighters[online.fid];
      if (me && typeof me.rage === 'number') touch.setRage(me.rage / (100 * 256));
      showResult(!!v.mode.over);
    }
    return;
  }
  if (!world) return;
  showResult(!!world.mode.over);
  const focus = world.fighters.map((f, i) => (f.kind === 'human' ? i : -1)).filter((i) => i >= 0);
  setHudHint(focus.filter((i) => srcOf[i] === 'P1'), hasTouch);
  renderer.draw(world, alpha, loop, focus, nameOf, (i) => world.defs[world.fighters[i].charId].name);
});

function updatePause() {
  const portrait = window.matchMedia('(orientation: portrait)').matches;
  const paused = !started || portrait || document.hidden || (movesOpen && !online); // 連線局不能暫停,招式表只蓋在上面
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
  home.hide();
  started = true;
  updatePause();
  if (!qs.has('nofs')) enterFullscreen();
  tip.show();
}

function startOnline(sess) {
  online = sess;
  world = null;
  renderer.prev = [];
  renderer.fx.clear();
  renderer.zoom = CAM.base;
  sess.onFx = (evs) => { for (const e of evs) renderer.fx.add(e); };
  $('result').classList.add('hide');
  resultShown = false;
  home.hide();
  started = true;
  updatePause();
  if (!qs.has('nofs')) enterFullscreen();
  tip.show();
}

function toMenu() {
  movesPanel.close();
  tip.hide();
  if (online) {
    online.stop();
    online = null;
  }
  started = false;
  $('result').classList.add('hide');
  resultShown = false;
  home.show();
  updatePause();
}

async function boot() {
  const ids = await (await fetch('data/chars/index.json')).json();
  chars = {};
  for (const id of ids) chars[id] = await (await fetch('data/chars/' + id + '.json')).json();
  stage = await (await fetch('data/stages/market.json')).json();
  home = setupHome($('menu'), {
    chars, charIds: ids, onStart: start, onPractice: start,
    onOnline: () => { room.onOpen(); home.showScreen('netpanel'); },
    onMoves: () => openMoves()
  });
  hasTouch = qs.has('touch') || 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  movesPanel = setupMoves($('moves'), {
    chars, charIds: ids,
    onToggle: (on) => { movesOpen = on; updatePause(); }
  });
  tip = setupTip($('tip'), { isTouch: () => hasTouch });
  $('btn-moves').addEventListener('click', () => openMoves());
  $('btn-help-tip').addEventListener('click', () => tip.show(true));
  room = setupRoom($('menu'), { chars, stage, charIds: ids, getChar: () => home.getChar(), onSession: startOnline });
  $('btn-net-back').onclick = () => home.showScreen('home');
  room.rejoin();
  renderer.zoomMax = CAM.base;
  renderer.zoomMin = CAM.min;
  renderer.zoom = CAM.base;
  // 開發用按鈕(盒子 / 場景 / 重置)只在網址帶 ?debug 時顯示
  document.body.classList.toggle('debug', qs.has('debug'));

  if (hasTouch) touch.show();
  if (qs.has('debug')) setDebug(true);

  $('btn-debug').addEventListener('click', () => setDebug(!renderer.debug));
  $('btn-reset').addEventListener('click', () => { if (!online) buildWorld(); });
  $('btn-menu').addEventListener('click', toMenu);
  $('btn-home').addEventListener('click', toMenu);
  $('btn-again').addEventListener('click', () => start(cfg && cfg.mode === 'practice' ? cfg : home.getCfg()));
  $('btn-scn').addEventListener('click', () => { scn = (scn + 1) % SCENARIOS.length; buildWorld(); });
  window.addEventListener('keydown', (e) => {
    if (started && e.code === 'KeyH' && !e.repeat) {
      if (movesPanel.isOpen()) movesPanel.close();
      else openMoves();
      return;
    }
    if (!started || movesPanel.isOpen() || online && e.code !== 'KeyB' && e.code !== 'Enter') return;
    if (e.code === 'KeyB') setDebug(!renderer.debug);
    else if (e.code === 'KeyR') buildWorld();
    else if (e.code === 'KeyN' && cfg.mode === 'practice') { scn = (scn + 1) % SCENARIOS.length; buildWorld(); }
    else if (e.code === 'Enter') toMenu();
    else if (e.code === 'KeyR' && !qs.has('debug')) return;
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
  window.__cb = { get world() { return world; }, input, loop, renderer, start, buildWorld, touch, home, toMenu, startOnline };
}

function setDebug(on) {
  renderer.debug = on;
  $('btn-debug').classList.toggle('on', on);
}

boot();
