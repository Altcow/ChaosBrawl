import { Loop } from './core/loop.js';
import { Input } from './core/input.js';
import { createWorld, stepWorld } from './sim/world.js';
import { layoutSpawns } from './sim/modes.js';
import { commandMacro, ULT_MACRO } from './sim/command.js';
import { S, STEP_SPEC } from './sim/fighter.js';
import { Renderer } from './render/renderer.js';
import { setupTouch } from './ui/touch.js';
import { setupHome } from './ui/select.js';
import { setupRoom } from './ui/room.js';
import { setupMoves, listMoves, cmdText, defaultDevice } from './ui/moves.js';
import { setupTip } from './ui/tip.js';
import { setHudHint } from './render/hud.js';
import { buildSet, REASON_TEXT } from './ui/gesture.js';
import { setupGuide } from './ui/guide.js';
import { setupTrainer } from './ui/trainer.js';
import { setupTutorial } from './ui/tutorial.js';
import { getSettings, tutorialSeen, addBattle, ringVisible } from './ui/settings.js';

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
let gd = null; // data/gestures.json
let guide = null;
let trainer = null;
let tutorial = null;
let pendingCfg = null; // 教學結束後要開的正式對戰
let justTutorial = false; // 剛做完教學:不再跳操作提示卡
let guideOpen = false;
let pending = null; // 手勢送出緩衝(角色暫時不能出招時保留 200ms)
let setCache = { id: '', set: [] };

const input = new Input();
input.attach();
const renderer = new Renderer($('game'));
const touch = setupTouch($('touch'), input, assist, specials, {
  getCtx: touchCtx,
  onGesture,
  fire,
  getTemplate: () => (tutorial && tutorial.isActive() ? tutorial.template() : trainer && trainer.isShown() ? trainer.template() : null),
  assist: () => getSettings().assist && !online && started,
  ringOn: () => ringVisible() || (cfg && cfg.mode === 'practice' && !online),
  onEvent: (t) => tutorial && tutorial.isActive() && tutorial.onEvent(t)
});

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

// ---- 手勢 → 動作 ----
// 目前本機角色的手勢表(依角色快取)
function mySet() {
  const me = myFighter();
  const id = me ? me.f.charId : cfg && cfg.slots[0] ? cfg.slots[0].char : '';
  if (!gd || !chars || !chars[id]) return [];
  if (setCache.id !== id) setCache = { id, set: buildSet(chars[id], gd) };
  return setCache.set;
}

function touchCtx() {
  const me = myFighter();
  if (!me || !gd) return null;
  const def = me.w.defs[me.f.charId];
  return { set: mySet(), face: me.f.face, mp: me.f.mp, ready: !!def.hasUlt && !me.f.ult && me.f.rage >= 100 * 256, canUlt: false };
}

// 角色現在能不能接收必殺 / 最強(同 sim/fighter.js ultAllowed:站走跑防、普攻取消窗、月步第 6 tick 起)
function canCast(f, def) {
  if (f.dead || f.y > 0) return false;
  switch (f.state) {
    case S.IDLE:
    case S.WALK:
    case S.RUN:
    case S.DEFEND:
      return true;
    case S.SQUAT:
      return f.st <= 4;
    case S.ATTACK: {
      const m = f.move && def.moves[f.move];
      return !!m && (f.mtot <= 4 || m.total - f.mtot <= m.cancel);
    }
    case S.STEP:
      return !f.stepLk && f.st >= 6;
    default:
      return false;
  }
}

// 要送必殺 / 最強:能出招就立刻送,否則保留最多 200ms(每 tick 檢查),逾時丟棄並提示「時機不對」
function cast(run) {
  const me = myFighter();
  if (me && canCast(me.f, me.w.defs[me.f.charId])) {
    pending = null;
    run();
    return;
  }
  pending = { run, until: performance.now() + 200 };
}
function flushPending() {
  if (!pending) return;
  const me = myFighter();
  if (me && canCast(me.f, me.w.defs[me.f.charId])) {
    const r = pending.run;
    pending = null;
    r();
  } else if (performance.now() > pending.until) {
    pending = null;
    touch.flash('時機不對', 'late');
  }
}

const STEP_KIND = { step_f: ['fwd', 1], step_b: ['back', 2], step_u: ['up', 3], step_d: ['down', 4] };

// 執行一個手勢 id(辨識成功或輔助按鈕);回傳要給觸控層顯示的回饋
function fire(id) {
  const me = myFighter();
  if (!me) return { kind: 'none', text: '' };
  const def = me.w.defs[me.f.charId];
  const g = mySet().find((x) => x.id === id);
  const name = g ? g.name : id;
  if (id === 'ultimate') {
    if (!def.hasUlt) return { kind: 'fail', text: '這個角色沒有最強必殺技' };
    if (me.f.rage < 100 * 256) return { kind: 'norage', text: '爆氣未滿' };
    cast(() => input.queueMacro('P1', ULT_MACRO));
    return { kind: 'ok', text: name };
  }
  if (id.indexOf('sp_') === 0) {
    const m = def.moves[id];
    if (!m) return { kind: 'fail', text: '這個角色沒有這招' };
    if (me.f.mp < m.cost) return { kind: 'nomp', text: name + ' MP 不足' };
    cast(() => {
      const m2 = myFighter();
      if (m2) input.queueMacro('P1', commandMacro(id, m2.f.face));
    });
    return { kind: 'ok', text: name };
  }
  const st = STEP_KIND[id];
  if (st) {
    if (me.f.stepP !== undefined && me.f.stepP < STEP_SPEC[st[1]].cost * 256) return { kind: 'nomp', text: '步力不足' };
    if (input.queueStep) input.queueStep('P1', st[0]);
    return { kind: 'ok', text: name };
  }
  return { kind: 'none', text: '' };
}

// 一筆手勢辨識完成(touch.js 回呼)
function onGesture(res) {
  if (trainer && trainer.isShown()) trainer.record(res);
  if (tutorial && tutorial.isActive()) tutorial.onGesture(res);
  if (res.reason === 'tap') return { kind: 'none', text: '' };
  if (!res.ok) {
    let t = REASON_TEXT[res.reason] || REASON_TEXT.unknown;
    const hintOn = (cfg && cfg.mode === 'practice') || ringVisible();
    const near = hintOn && res.nearest && mySet().find((x) => x.id === res.nearest);
    if (near) t += ' 像是:' + near.name + '?';
    return { kind: 'fail', text: t };
  }
  return fire(res.id);
}

// 練習場 / 教學:不耗 MP、爆氣與步力常滿(只動本機單機世界)
function refillFree() {
  if (online || !world || !cfg || cfg.mode !== 'practice') return;
  const on = (tutorial && tutorial.isActive()) || (trainer && trainer.isShown() && trainer.freeMp());
  if (!on) return;
  const i = srcOf.indexOf('P1');
  const f = world.fighters[i];
  if (!f) return;
  const def = world.defs[f.charId];
  f.mp = def.mp;
  if (def.hasUlt && !f.ult) f.rage = 100 * 256;
  if (f.stepP !== undefined) f.stepP = 100 * 256;
}

// 手勢書「去練習」:進練習場並指定該手勢
function goPractice(charId, gid) {
  if (online) return;
  guide.close();
  movesPanel.close();
  if (started) toMenu();
  start({ mode: 'practice', ff: 0, slots: [{ kind: 'P1', char: charId, team: 0 }] });
  if (trainer) trainer.setTarget(gid);
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
  flushPending();
  if (online) {
    online.tick(input.read('P1'));
    return;
  }
  refillFree();
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
  const paused = !started || portrait || document.hidden || ((movesOpen || guideOpen) && !online); // 連線局不能暫停,招式表只蓋在上面
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
  // 手機第一次打單機:先跑 4 步互動教學(練習場景,木樁不還手),做完 / 跳過再開正式對戰
  if (hasTouch && tutorial && gd && c.mode !== 'practice' && !tutorialSeen()) {
    const p1 = c.slots.find((s) => s.kind === 'P1') || c.slots.find((s) => s.kind !== 'off');
    pendingCfg = c;
    cfg = { mode: 'practice', ff: 0, slots: [{ kind: 'P1', char: p1.char, team: 0 }] };
    buildWorld();
    home.hide();
    started = true;
    updatePause();
    if (!qs.has('nofs')) enterFullscreen();
    trainer.hide();
    tutorial.start();
    return;
  }
  cfg = c;
  buildWorld();
  home.hide();
  started = true;
  updatePause();
  if (!qs.has('nofs')) enterFullscreen();
  if (c.mode !== 'practice') addBattle();
  if (trainer) {
    if (c.mode === 'practice' && hasTouch) trainer.show();
    else trainer.hide();
  }
  if (!justTutorial && (!hasTouch || c.mode !== 'practice')) tip.show();
  justTutorial = false;
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
  addBattle();
  if (trainer) trainer.hide();
  tip.show();
}

function toMenu() {
  movesPanel.close();
  if (guide) guide.close();
  if (tutorial && tutorial.isActive()) tutorial.cancel();
  pendingCfg = null;
  pending = null;
  if (trainer) trainer.hide();
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
  try {
    gd = await (await fetch('data/gestures.json')).json();
  } catch (e) {
    gd = null; // 沒有手勢資料:觸控版面照常,只是畫手勢沒有招式可比對
  }
  home = setupHome($('menu'), {
    chars, charIds: ids, onStart: start, onPractice: start,
    onOnline: () => { room.onOpen(); home.showScreen('netpanel'); },
    onMoves: () => openMoves(),
    onGuide: (id) => guide && gd && (id ? guide.open(id) : guide.openRules())
  });
  hasTouch = qs.has('touch') || 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  movesPanel = setupMoves($('moves'), {
    chars, charIds: ids, gd,
    onToggle: (on) => { movesOpen = on; updatePause(); },
    onGuide: (id) => guide && gd && guide.open(id)
  });
  if (gd) {
    guide = setupGuide($('guide'), { chars, charIds: ids, gd, onPractice: goPractice, onToggle: (on) => { guideOpen = on; updatePause(); } });
    trainer = setupTrainer($('trainer'), { getSet: mySet, getCharId: () => (setCache.id || (cfg && cfg.slots[0] ? cfg.slots[0].char : '')) });
    tutorial = setupTutorial($('tut'), {
      gd,
      getSet: mySet,
      onDone: () => {
        const c = pendingCfg;
        pendingCfg = null;
        justTutorial = true;
        if (c) start(c);
      }
    });
  }
  tip = setupTip($('tip'), { isTouch: () => hasTouch });
  $('btn-moves').addEventListener('click', () => openMoves());
  $('btn-help-tip').addEventListener('click', () => tip.show(true));
  $('btn-clear-cache')?.addEventListener('click', async () => {
    try {
      if (navigator.serviceWorker) for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
      if (window.caches) for (const k of await caches.keys()) await caches.delete(k);
    } catch (e) { console.warn(e); }
    location.reload();
  });
  $('btn-guide-help')?.addEventListener('click', () => guide && gd && guide.open(home.getPrefChar() === 'random' ? null : home.getPrefChar()));
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
  window.__cb = { get world() { return world; }, input, loop, renderer, start, buildWorld, touch, home, toMenu, startOnline, guide, trainer, tutorial, fire, goPractice, get gd() { return gd; }, mySet };
}

function setDebug(on) {
  renderer.debug = on;
  $('btn-debug').classList.toggle('on', on);
}

boot();
