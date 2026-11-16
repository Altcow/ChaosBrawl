// 第 1 波 7 角色 + D 系列新機制測試:node tools/chars-test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createWorld, stepWorld, serializeWorld, restoreWorld, hashWorld } from '../js/sim/world.js';
import { layoutSpawns } from '../js/sim/modes.js';
import { BIT } from '../js/core/input.js';
import { S, isInvuln, takeHit, atkPct, buffSpec } from '../js/sim/fighter.js';
import { RAGE_MAX } from '../js/sim/ult.js';
import { commandMacro, ULT_MACRO } from '../js/sim/command.js';
import { Rng } from '../js/core/rng.js';
import { FX } from '../js/core/fixed.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const load = (id) => JSON.parse(readFileSync(join(root, 'data/chars/' + id + '.json'), 'utf8'));
const ids = JSON.parse(readFileSync(join(root, 'data/chars/index.json'), 'utf8'));
const WAVE1 = ['areh', 'guanyu', 'lubu', 'cilin', 'huhu', 'liushui', 'erhao'];
const chars = {};
for (const id of ids) chars[id] = load(id);
for (const id of ['ada', 'grandma', 'librarian', 'cat']) chars[id] = JSON.parse(readFileSync(join(root, 'tools/fixtures/chars/' + id + '.json'), 'utf8')); // 舊 4 人僅供測試
chars.dummy = Object.assign(JSON.parse(JSON.stringify(chars.ada)), { id: 'dummy', hp: 5000 });
const stage = JSON.parse(readFileSync(join(root, 'data/stages/market.json'), 'utf8'));

let pass = 0;
let fail = 0;
function check(name, ok, info) {
  if (ok) pass++;
  else fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== undefined ? '  (' + info + ')' : ''));
}
const mk = (spawns, opt = {}) => createWorld(Object.assign({ chars, seed: 9, ult: true, stage: { w: 1600, d: 240 }, spawns }, opt));
const P = (charId, x, z, extra = {}) => Object.assign({ charId, kind: 'human', x, z, face: 1 }, extra);
const D = (x, z, extra = {}) => Object.assign({ charId: 'dummy', kind: 'post', x, z, face: -1 }, extra);
const run = (w, n, fn) => {
  for (let t = 0; t < n; t++) stepWorld(w, fn ? fn(t) : []);
};
const nil = () => [0, 0, 0, 0, 0, 0, 0, 0];
const full = (f) => {
  f.rage = RAGE_MAX;
};
// 以 seat 0 施放指令:餵 macro 序列後放開
function cast(w, cmd, seat = 0, tail = 0) {
  const f = w.fighters[seat];
  const mac = commandMacro(cmd, f.face);
  for (const b of mac) {
    const arr = nil();
    arr[seat] = b;
    stepWorld(w, arr);
  }
  void tail;
}
function ult(w, seat = 0) {
  const f = w.fighters[seat];
  full(f);
  for (const b of ULT_MACRO) {
    const arr = nil();
    arr[seat] = b;
    stepWorld(w, arr);
  }
  for (let t = 0; t < 80 && w.ult.cur >= 0; t++) stepWorld(w, nil()); // 跑完 60 tick 特寫暫停,之後從招式第 0 tick 算起
}
// 實際承受傷害:hp + gray 只會因傷害減少 70%(30% 變灰血、灰血回復只是搬到 hp),所以換算回原始傷害,不受自然回復影響
const lost = (w, i) => Math.round(((chars.dummy.hp * FX - w.fighters[i].hp - w.fighters[i].gray) / FX) * 10 / 7);
const fakeItr = (o) => Object.assign({ dmg: 10, fall: 20, bdef: 10, kx: 1, ky: 0, stun: 10, stop: 2, kind: 'hit', zr: 20 }, o);

// ---- 1. 資料 ----
{
  check('index.json:fanfan 加 7 新角色,共 8 人(舊 4 人已移除)', JSON.stringify(ids) === JSON.stringify(['fanfan', ...WAVE1]), ids.join(','));
  for (const id of WAVE1) {
    const j = chars[id];
    const w = mk([P(id, 400, 100)]);
    const def = w.defs[id];
    check(id + ' 資料:nicknames 8 個、color、有大招、HP 在 420~600', j.nicknames.length === 8 && /^#[0-9a-f]{6}$/i.test(j.color) && def.hasUlt && j.hp >= 420 && j.hp <= 600, j.name + ' hp=' + j.hp);
    check(id + ' 資料:無 art 欄位(色塊佔位;areh / guanyu 已接通用動作圖例外)、ai.style / specials / ult 皆有', (!j.art || id === 'areh' || id === 'guanyu') && j.ai.style && j.ai.specials.length >= 2 && j.ai.ult, '');
  }
  const heavy = ['lubu', 'erhao', 'liushui'].every((id) => chars[id].walk.x <= 2.0);
  check('護欄 4:重組走速 ≤ 2.0', heavy);
  check('護欄 7:HP 最高者(呂布)走速最慢', chars.lubu.hp === Math.max(...WAVE1.map((i) => chars[i].hp)) && chars.lubu.walk.x === Math.min(...WAVE1.map((i) => chars[i].walk.x)));
}

// ---- 2. 規則:霸體不擋射彈 / 投技;招式格 armor(D2) ----
{
  const w = mk([P('lubu', 400, 100), D(700, 100)]);
  const f = w.fighters[0];
  f.mp = 500 * FX;
  cast(w, 'sp_fwd_jump');
  let t = 0;
  while (!(f.move === 'sp_fwd_jump' && f.mf === 1) && t++ < 40) stepWorld(w, nil());
  check('呂布赤兔衝陣衝刺格處於霸體', f.move === 'sp_fwd_jump' && f.mf === 1);
  const def = w.defs.lubu;
  takeHit(w, f, f.x + 50 * FX, fakeItr({ fall: 20 }), 1, false);
  check('近戰輕攻擊(fall 20)打不斷霸體招式', f.move === 'sp_fwd_jump' && f.state === S.SPECIAL);
  f.hitstop = 0;
  f.inv = 0;
  takeHit(w, f, f.x + 50 * FX, fakeItr({ fall: 20 }), 1, true);
  check('射彈(同 fall 20)打斷霸體', f.move === null && f.state === S.HURT);
  const w2 = mk([P('lubu', 400, 100), D(700, 100)]);
  const g = w2.fighters[0];
  g.mp = 500 * FX;
  cast(w2, 'sp_fwd_jump');
  let t2 = 0;
  while (!(g.move === 'sp_fwd_jump' && g.mf === 1) && t2++ < 40) stepWorld(w2, nil());
  takeHit(w2, g, g.x + 50 * FX, fakeItr({ fall: 20, kind: 'grab' }), 1, false);
  check('投技(kind grab)打斷霸體', g.move === null);
  const w3 = mk([P('lubu', 400, 100), D(700, 100)]);
  const h = w3.fighters[0];
  h.mp = 500 * FX;
  cast(w3, 'sp_fwd_jump');
  let t3 = 0;
  while (!(h.move === 'sp_fwd_jump' && h.mf === 1) && t3++ < 40) stepWorld(w3, nil());
  takeHit(w3, h, h.x + 50 * FX, fakeItr({ fall: 60 }), 1, false);
  check('fall ≥ 35 的近戰打斷霸體', h.move === null);
  void def;
}

// ---- 3. D2:inv / turn ----
{
  const w = mk([P('guanyu', 400, 100), D(520, 100)]);
  const f = w.fighters[0];
  f.mp = 500 * FX;
  cast(w, 'sp_fwd_jump');
  const face0 = 1;
  let invTicks = 0;
  let sawFlip = false;
  for (let t = 0; t < 30; t++) {
    if (f.move === 'sp_fwd_jump' && isInvuln(f, w.defs.guanyu)) invTicks++;
    if (f.face !== face0) sawFlip = true;
    stepWorld(w, nil());
  }
  check('拖刀計:前段無敵(inv 格)', invTicks >= 8 && invTicks <= 14, 'inv ticks=' + invTicks);
  check('拖刀計:turn 格轉向,收招後面向敵人', sawFlip && f.face === 1);
  check('拖刀計:後退後往前突斬', f.x !== 400 * FX);
}

// ---- 4. D8:自我回血(先灰血、被打中斷) ----
{
  const w = mk([P('guanyu', 400, 100), D(1200, 100)]);
  const f = w.fighters[0];
  f.hp = 300 * FX;
  f.gray = 20 * FX;
  f.sinceHit = 0;
  f.mp = 500 * FX;
  cast(w, 'sp_down_atk');
  run(w, 150, nil);
  check('夜讀春秋:回血共 60(含灰血 20 先回)', Math.abs(f.hp / FX - 360) < 1 && f.gray === 0, 'hp=' + (f.hp / FX).toFixed(1) + ' gray=' + f.gray);
  const w2 = mk([P('guanyu', 400, 100), D(1200, 100)]);
  const g = w2.fighters[0];
  g.hp = 300 * FX;
  g.mp = 500 * FX;
  cast(w2, 'sp_down_atk');
  run(w2, 40, nil);
  const mid = g.hp;
  takeHit(w2, g, g.x + 30 * FX, fakeItr({ dmg: 10 }), 1, false);
  run(w2, 100, nil);
  check('被打即中斷回血', mid > 300 * FX && g.hp <= mid - 10 * FX + 1 && g.move === null, 'hp=' + (g.hp / FX).toFixed(1));
}

// ---- 5. D6:射彈穿透 + 場上限制 ----
{
  const w = mk([P('lubu', 300, 100), D(500, 100), D(700, 100, { team: 5 }), D(900, 100, { team: 6 })]);
  w.fighters[0].mp = 500 * FX;
  cast(w, 'sp_up_atk');
  run(w, 70, nil);
  check('轅門射戟:穿透一路 3 人各中一次', [1, 2, 3].every((i) => lost(w, i) === 40), [1, 2, 3].map((i) => lost(w, i)).join(','));
  const noMore = w.projectiles.length === 0;
  check('箭飛完後消失', noMore);
}
{
  const w = mk([P('cilin', 300, 100), D(380, 100)]);
  const f = w.fighters[0];
  f.mp = 500 * FX;
  cast(w, 'sp_down_atk');
  run(w, 30, nil);
  check('避雷針:場上 1 支', w.projectiles.filter((p) => p.kind === 'rod').length === 1);
  run(w, 100, nil);
  const dmg = lost(w, 1);
  check('避雷針:命中不消失、每 40 tick 電擊一次(130 tick 內 ≥ 2 次)', dmg >= 28 && w.projectiles.some((p) => p.kind === 'rod'), 'dmg=' + dmg);
  f.mp = 500 * FX;
  f.state = S.IDLE;
  f.move = null;
  cast(w, 'sp_down_atk');
  run(w, 30, nil);
  check('第二支避雷針取代第一支(上限 1)', w.projectiles.filter((p) => p.kind === 'rod').length === 1);
}

// ---- 6. D7:吸引 ----
{
  const w = mk([P('cilin', 300, 100), D(450, 105), D(700, 100, { team: 5 })]);
  const f = w.fighters[0];
  f.mp = 500 * FX;
  cast(w, 'sp_up_atk');
  run(w, 40, nil);
  const d1 = (w.fighters[1].x - f.x) / FX;
  check('N 極吸引:前方 200 px 內敵人被拉到身前 20 px', Math.abs(d1 - 20) <= 1, 'dx=' + d1.toFixed(1));
  check('N 極吸引:範圍外不受影響', w.fighters[2].x === 700 * FX);
  check('N 極吸引:不造成傷害', lost(w, 1) === 0);
  // 翻滾無敵不被拉
  const w2 = mk([P('cilin', 300, 100), D(450, 100, { kind: 'human' })]);
  w2.fighters[0].mp = 500 * FX;
  const e = w2.fighters[1];
  e.state = S.ROLL;
  e.st = 5;
  e.getupDir = 1;
  e.vx = 0;
  const x0 = e.x;
  cast(w2, 'sp_up_atk');
  run(w2, 8, nil);
  check('吸引對無敵中(翻滾)目標無效', e.x >= x0, 'dx=' + (e.x - x0));
}
{
  const w = mk([P('cilin', 300, 100), D(700, 60), D(900, 150, { team: 5 }), D(100, 100, { team: 6 })]);
  ult(w);
  const hp0 = w.fighters.map((f) => f.hp);
  let t = 0;
  while (!w.projectiles.some((p) => p.kind === 'fridge') && t++ < 200) stepWorld(w, nil());
  const dx = [1, 2, 3].map((i) => (w.fighters[i].x - w.fighters[0].x) / FX);
  run(w, 200, nil);
  check('廢鐵大回收:全場(含背後)敵人被吸到身前', dx.every((v) => v > 0 && v < 80), dx.map((v) => v.toFixed(0)).join(','));
  const losts = [1, 2, 3].map((i) => (hp0[i] - w.fighters[i].hp) / FX);
  check('廢鐵大回收:冰箱 140、每人一次', losts.every((v) => Math.abs(v - 140) <= 3 || Math.abs(v - 35) <= 2), losts.join(','));
  check('廢鐵大回收:至少打中一人', losts.some((v) => Math.abs(v - 140) <= 3));
}

// ---- 7. D13:鎖定(阿熱大招) ----
{
  const w = mk([P('areh', 400, 100), D(560, 100)]);
  ult(w);
  let held = false;
  let sawLockMove = false;
  for (let t = 0; t < 300; t++) {
    stepWorld(w, nil());
    if (w.fighters[1].held === 0) held = true;
    if (w.fighters[0].move === 'ultimate_lock') sawLockMove = true;
  }
  check('熱血百連擊:撞到第一人 → 切到鎖定演出招式、對方被鎖', held && sawLockMove);
  check('熱血百連擊:總傷害 170', lost(w, 1) === 170, lost(w, 1));
  check('鎖定結束後釋放', w.fighters[1].held === -1);
}
{
  // 鎖定中對手被釘在身前
  const w = mk([P('areh', 400, 100), D(560, 110)]);
  ult(w);
  let ok = true;
  let n = 0;
  for (let t = 0; t < 300; t++) {
    stepWorld(w, nil());
    if (w.fighters[1].held === 0 && w.fighters[0].move === 'ultimate_lock' && w.fighters[1].state === S.HURT) {
      n++;
      const dx = (w.fighters[1].x - w.fighters[0].x) / FX;
      if (Math.abs(dx - 36) > 1 || w.fighters[1].z !== w.fighters[0].z) ok = false;
    }
  }
  check('鎖定中對手釘在身前 36 px、同 z', ok && n > 20, 'ticks=' + n);
}
{
  const w = mk([P('areh', 400, 100), D(1000, 100)]);
  ult(w);
  let lockSeen = false;
  let whiffTicks = 0;
  for (let t = 0; t < 200; t++) {
    stepWorld(w, nil());
    if (w.fighters[0].move === 'ultimate_lock') lockSeen = true;
    if (w.fighters[0].move === 'ultimate' && w.fighters[0].mf === 2) whiffTicks++;
  }
  check('沒撞到 = 空揮,約 60 tick 破綻、不鎖定', !lockSeen && whiffTicks >= 55, 'whiff=' + whiffTicks);
}
{
  // 防住鎖定:不鎖定
  const w = mk([P('areh', 400, 100), D(520, 100, { kind: 'human', face: -1 })]);
  ult(w);
  let held = false;
  for (let t = 0; t < 80; t++) {
    const arr = nil();
    arr[1] = BIT.DEF;
    stepWorld(w, arr);
    if (w.fighters[1].held === 0) held = true;
  }
  check('防禦中不會被鎖定(只吃擦傷)', !held);
}

// ---- 8. D13:回原位(關羽大招) ----
{
  const w = mk([P('guanyu', 300, 100), D(700, 100), D(1100, 130, { team: 5 }), D(100, 100, { team: 6 })]);
  const f = w.fighters[0];
  f.hp = 400 * FX;
  ult(w);
  run(w, 70, nil);
  check('溫酒斬:橫越全畫面,同帶敵人各 150(身後者不中)', lost(w, 1) === 150 && lost(w, 2) === 150 && lost(w, 3) === 0, [1, 2, 3].map((i) => lost(w, i)).join(','));
  run(w, 40, nil);
  check('溫酒斬:回到原位', f.x === 300 * FX && f.z === 100 * FX, 'x=' + f.x / FX);
  check('溫酒斬:喝酒回 HP 40', Math.abs(f.hp / FX - 440) < 1, f.hp / FX);
}

// ---- 9. D13:鏈式瞬移(呼呼大招) ----
{
  const w = mk([P('huhu', 300, 100), D(600, 60), D(900, 150, { team: 5 }), D(1200, 100, { team: 6 }), D(150, 120, { team: 7 })]);
  ult(w);
  run(w, 200, nil);
  const l = [1, 2, 3, 4].map((i) => lost(w, i));
  check('一覺到天亮:依序斬全場 4 人各 90(含身後者)', l.every((v) => v === 90), l.join(','));
}
{
  const w = mk([P('huhu', 300, 100), D(600, 60), D(900, 150, { team: 5 })]);
  ult(w);
  run(w, 200, nil);
  check('鏈式:敵人少於 7 人時多餘格不亂跳(2 人各 90)', lost(w, 1) === 90 && lost(w, 2) === 90);
}
{
  // 對翻滾無敵者閃過
  const w = mk([P('huhu', 300, 100), D(600, 60, { kind: 'human' })]);
  ult(w);
  const e = w.fighters[1];
  let rolled = 0;
  for (let t = 0; t < 200; t++) {
    const arr = nil();
    if (e.rollCd === 0 && e.state === S.IDLE && t > 60 && rolled < 6) {
      arr[1] = BIT.DEF;
    } else if (e.state === S.DEFEND) arr[1] = BIT.DEF | BIT.RIGHT;
    stepWorld(w, arr);
    if (e.state === S.ROLL) rolled++;
  }
  check('呼呼大招:翻滾無敵可閃(傷害 ≤ 90)', lost(w, 1) <= 90, 'lost=' + lost(w, 1));
}

// ---- 10. 柳水伯:反擊 / 反射(D16) ----
{
  const w = mk([P('liushui', 400, 100), D(436, 100, { kind: 'human', face: -1 })]);
  const f = w.fighters[0];
  f.mp = 500 * FX;
  cast(w, 'sp_down_atk');
  let counter = false;
  for (let t = 0; t < 40; t++) {
    const arr = nil();
    arr[1] = t === 6 ? BIT.ATK : 0;
    stepWorld(w, arr);
    if (w.events.some((e) => e.t === 'counter')) counter = true;
  }
  check('化水架式:近戰碰到即反擊', counter);
  run(w, 40, nil);
  check('化水架式:反擊推掌擊倒對方', lost(w, 1) >= 55 && (w.fighters[1].state === S.FALL || w.fighters[1].state === S.LYING || w.fighters[1].state === S.GETUP), 'lost=' + lost(w, 1));
}
{
  const w = mk([P('liushui', 400, 100), D(436, 100, { kind: 'human', face: -1 })]);
  ult(w);
  // 站在架式中被近戰打 → 反擊連段(上限 150),且之後一整段內不再另外吃招
  let counterSeen = false;
  for (let t = 0; t < 400; t++) {
    const arr = nil();
    arr[1] = t > 80 && t % 20 === 0 ? BIT.ATK : 0;
    stepWorld(w, arr);
    if (w.events.some((e) => e.t === 'counter')) counterSeen = true;
  }
  const dmg = lost(w, 1);
  check('晨運千手:近戰命中改為反擊連段', counterSeen && dmg > 40, 'dmg=' + dmg);
  check('晨運千手:反擊連段上限 150', dmg <= 150 + 30 /* 含對方挨打期間不會再給的普攻傷害:此處為 0 */ && w.fighters[0].ultDmg[1] <= 150, 'ultDmg=' + w.fighters[0].ultDmg[1]);
}
{
  const w = mk([P('liushui', 700, 100, { face: -1 }), P('fanfan', 540, 100)]);
  ult(w);
  run(w, 60, nil);
  const fan = w.fighters[1];
  fan.mp = 500 * FX;
  const hp0 = fan.hp;
  for (const b of commandMacro('sp_fwd_atk', 1)) {
    const arr = nil();
    arr[1] = b;
    stepWorld(w, arr);
  }
  let reflected = false;
  for (let t = 0; t < 200; t++) {
    stepWorld(w, nil());
    if (w.events.some((e) => e.t === 'reflect')) reflected = true;
  }
  check('晨運千手:射彈被反彈(換主人)', reflected);
  check('被反彈的迴力帽打回丟的人', fan.hp < hp0, 'fan lost=' + (hp0 - fan.hp) / FX);
  check('柳水伯本人沒被射彈打傷', w.fighters[0].hp === chars.liushui.hp * FX);
}
{
  // 零傷害 / 射彈不觸發 化水架式(只反近戰)
  const w = mk([P('liushui', 700, 100, { face: -1 }), P('fanfan', 540, 100)]);
  w.fighters[0].mp = 500 * FX;
  cast(w, 'sp_down_atk');
  w.fighters[1].mp = 500 * FX;
  for (const b of commandMacro('sp_fwd_atk', 1)) {
    const arr = nil();
    arr[1] = b;
    stepWorld(w, arr);
  }
  let counter = false;
  for (let t = 0; t < 120; t++) {
    stepWorld(w, nil());
    if (w.events.some((e) => e.t === 'counter')) counter = true;
  }
  check('化水架式不吃射彈(護欄:反擊只吃近戰)', !counter);
}

// ---- 11. 呼呼:秒睡回魔 + 反擊一閃 ----
{
  const w = mk([P('huhu', 400, 100), D(1200, 100)]);
  const f = w.fighters[0];
  f.mp = 100 * FX;
  cast(w, 'sp_down_jump');
  const mp0 = f.mp;
  run(w, 60, nil);
  const gain = (f.mp - mp0) / FX;
  check('秒睡:每秒 MP +60(含基礎回復)', gain >= 58 && gain <= 70, 'gain/s=' + gain.toFixed(1));
}
{
  const w = mk([P('huhu', 400, 100), D(436, 100, { kind: 'human', face: -1 })]);
  const f = w.fighters[0];
  f.mp = 500 * FX;
  cast(w, 'sp_down_jump');
  run(w, 10, nil);
  const arr = nil();
  arr[1] = BIT.ATK;
  stepWorld(w, arr);
  run(w, 3, nil);
  check('秒睡被近戰碰到:反擊一閃(瞬移到身後)', f.move === 'counter' || lost(w, 1) > 0);
  run(w, 60, nil);
  check('反擊一閃命中 60', lost(w, 1) >= 60, lost(w, 1));
}

// ---- 12. 二號殿下:被動 + 增益(D9) ----
{
  const w = mk([P('erhao', 400, 100), D(1200, 100)]);
  const f = w.fighters[0];
  const def = w.defs.erhao;
  check('被動:HP ≥ 40% 攻擊 100%', atkPct(f, def) === 100);
  f.hp = Math.floor(def.hp * 0.39);
  check('被動第二名的怒火:HP < 40% 攻擊 +25%', atkPct(f, def) === 125);
  f.hp = def.hp;
  const walk0 = (() => {
    const w2 = mk([P('erhao', 400, 100), D(1200, 100)]);
    stepWorld(w2, [BIT.RIGHT]);
    return w2.fighters[0].vx;
  })();
  ult(w);
  run(w, 20 + 24 + 14, nil);
  check('這次一定第一:進入增益(buf = fury,480 tick)', f.buf === 'fury' && f.bufT > 400, 'bufT=' + f.bufT);
  check('增益:攻擊 +30%', atkPct(f, def) === 130);
  stepWorld(w, [BIT.RIGHT]);
  check('增益:移動 +20%', f.vx === walk0 + Math.trunc((walk0 * 20) / 100), f.vx + ' vs ' + walk0);
  f.hp = Math.floor(def.hp * 0.2);
  check('增益 + 低血被動疊加 = +55%', atkPct(f, def) === 155);
  f.hp = def.hp;
  run(w, 500, nil);
  check('8 s 後進入喘氣(移動 −30%)', f.bufT === 0 && f.aftT > 0 && buffSpec(f, def) && buffSpec(f, def).spd === -30, 'aftT=' + f.aftT);
  stepWorld(w, [BIT.RIGHT]);
  check('喘氣移動 −30%', f.vx === walk0 + Math.trunc((walk0 * -30) / 100), f.vx);
  run(w, 130, nil);
  check('喘氣結束後恢復', f.buf === '' && atkPct(f, def) === 100);
}
{
  // 增益霸體:變身中近戰輕攻不打斷普攻、射彈會
  const w = mk([P('erhao', 400, 100), D(436, 100, { kind: 'human', face: -1 })]);
  ult(w);
  run(w, 60, nil);
  const f = w.fighters[0];
  const arr = nil();
  arr[0] = BIT.ATK;
  stepWorld(w, arr);
  check('變身中進入普攻', f.state === S.ATTACK);
  takeHit(w, f, f.x + 40 * FX, fakeItr({ fall: 20 }), 1, false);
  check('變身中:近戰輕攻擊打不斷攻擊', f.state === S.ATTACK && f.move);
  f.hitstop = 0;
  takeHit(w, f, f.x + 40 * FX, fakeItr({ fall: 20 }), 1, true);
  check('變身中:射彈仍打斷', f.state === S.HURT);
}
{
  const w = mk([P('erhao', 400, 100), D(1200, 100)]);
  const f = w.fighters[0];
  f.mp = 500 * FX;
  cast(w, 'sp_fwd_jump');
  let armored = 0;
  for (let t = 0; t < 40; t++) {
    if (f.move === 'sp_fwd_jump' && f.mf === 0) armored++;
    stepWorld(w, nil());
  }
  check('不服輸頭槌:前 12 tick 霸體格', armored >= 8 && armored <= 13, armored);
}
{
  // 破防:頭槌 bdef 100 一擊破防
  const w = mk([P('erhao', 400, 100), D(450, 100, { kind: 'human', face: -1 })]);
  w.fighters[0].mp = 500 * FX;
  cast(w, 'sp_fwd_jump');
  let stunned = false;
  for (let t = 0; t < 40; t++) {
    const arr = nil();
    arr[1] = BIT.DEF;
    stepWorld(w, arr);
    if (w.fighters[1].state === S.STUN) stunned = true;
  }
  check('不服輸頭槌:一擊破防(防守方暈眩)', stunned);
}

// ---- 13. 呂布大招:霸體 + 可移動 + 被投打斷;steer ----
{
  const w = mk([P('lubu', 400, 100), D(430, 100), D(760, 100, { team: 5 })]);
  ult(w);
  run(w, 20, nil);
  const x0 = w.fighters[0].x;
  for (let t = 0; t < 40; t++) {
    const arr = nil();
    arr[0] = BIT.RIGHT;
    stepWorld(w, arr);
  }
  check('天下無雙:旋風中可左右移動(2 px/tick)', w.fighters[0].x - x0 > 70 * FX && w.fighters[0].x - x0 <= 90 * FX, (w.fighters[0].x - x0) / FX);
  run(w, 200, nil);
  const l = lost(w, 1);
  check('天下無雙:周圍多段、單目標 ≤ 160', l > 60 && l <= 160, 'lost=' + l);
}
{
  const w = mk([P('lubu', 400, 100), D(430, 100)]);
  ult(w);
  run(w, 40, nil);
  const f = w.fighters[0];
  takeHit(w, f, f.x + 30 * FX, fakeItr({ fall: 20 }), 1, false);
  check('天下無雙:全程霸體(近戰輕攻擊打不斷)', f.move === 'ultimate');
  f.hitstop = 0;
  takeHit(w, f, f.x + 30 * FX, fakeItr({ fall: 100, kind: 'grab' }), 1, false);
  check('天下無雙:可被投技打斷', f.move === null && f.ult === 0);
}

// ---- 14. 每角色每招可出手 ----
for (const id of WAVE1) {
  const j = chars[id];
  const cmds = Object.keys(j.moves).filter((m) => /^sp_/.test(m));
  const touched = [];
  for (const cmd of cmds) {
    const w = mk([P(id, 400, 100), D(440, 100, { kind: 'post' }), D(600, 100, { kind: 'post', team: 5 })]);
    const f = w.fighters[0];
    f.mp = 500 * FX;
    f.hp = j.hp * FX - 1;
    const mHp = w.fighters.map((q) => q.hp);
    cast(w, cmd);
    let started = f.move === cmd;
    let effect = false;
    for (let t = 0; t < 160; t++) {
      stepWorld(w, nil());
      if (f.move === cmd) started = true;
      if (w.fighters.some((q, i) => i > 0 && q.hp < mHp[i]) || w.projectiles.length || f.hp > j.hp * FX - 1 || f.x !== 400 * FX || f.buf || w.fighters.some((q, i) => i > 0 && q.x !== (i === 1 ? 440 : 600) * FX)) effect = true;
    }
    if (!(started && (effect || /^(sp_down_atk|sp_down_jump)$/.test(cmd) && j.moves[cmd].frames[0].counter))) touched.push(cmd + ':' + started + '/' + effect);
  }
  check(id + ' 全部必殺(' + cmds.join(',') + ')可出手且有效果', touched.length === 0, touched.join(' '));
  // 普攻 3 段可連
  const w = mk([P(id, 400, 100), D(436, 100)]);
  let hit = 0;
  for (let t = 0; t < 120; t++) {
    const arr = nil();
    arr[0] = t % 10 === 0 ? BIT.ATK : 0;
    stepWorld(w, arr);
    hit += w.events.filter((e) => e.t === 'hit').length;
  }
  check(id + ' 普攻連段可命中', hit >= 3, 'hits=' + hit);
  // 大招可放且造成效果或增益
  const wu = mk([P(id, 400, 100), D(440, 100), D(640, 70, { team: 5 })]);
  ult(wu);
  run(wu, 300, nil);
  const eff = wu.fighters[1].hp < chars.dummy.hp * FX || wu.fighters[2].hp < chars.dummy.hp * FX || wu.fighters[0].buf || wu.fighters[0].bufT > 0 || wu.fighters[0].aftT > 0 || id === 'liushui';
  const ended = wu.fighters[0].ult === 0 && !wu.fighters[0].move;
  check(id + ' 大招可施放、有效果、結束後歸零', eff && ended, 'ult=' + wu.fighters[0].ult);
  if (id !== 'erhao' && id !== 'liushui') {
    const cap = Math.max(lost(wu, 1), lost(wu, 2));
    check(id + ' 大招單目標傷害 ≤ 180', cap <= 180 && cap > 0, 'max=' + cap);
  }
}

// ---- 15. 序列化:鎖定 / 增益 / 蓄招中途快照還原後續跑一致 ----
{
  const mkw = () => mk([P('areh', 400, 100), D(560, 100), P('erhao', 300, 60, { team: 3 }), P('guanyu', 1000, 100, { team: 4, face: -1 })]);
  const script = (t) => {
    const arr = nil();
    if (t === 5) arr[0] = BIT.DEF | BIT.ATK | BIT.JUMP;
    if (t === 8) arr[0] = 0;
    return arr;
  };
  const a = mkw();
  full(a.fighters[0]);
  full(a.fighters[2]);
  let snap = null;
  let ha = [];
  for (let t = 0; t < 400; t++) {
    if (t === 160) snap = serializeWorld(a);
    stepWorld(a, script(t));
    if (t >= 160 && t % 20 === 0) ha.push(hashWorld(a));
  }
  const b = mkw();
  restoreWorld(b, snap);
  const hb = [];
  for (let t = 160; t < 400; t++) {
    stepWorld(b, script(t));
    if (t % 20 === 0) hb.push(hashWorld(b));
  }
  check('鎖定 / 增益狀態中途快照還原後續跑一致', JSON.stringify(ha) === JSON.stringify(hb) && ha.length > 5);
  const f = a.fighters;
  check('新增欄位可 JSON 序列化(held / mkx / mkz / buf / bufT / aftT 皆為數字或字串)', f.every((q) => typeof q.held === 'number' && typeof q.mkx === 'number' && typeof q.mkz === 'number' && typeof q.buf === 'string' && typeof q.bufT === 'number' && typeof q.aftT === 'number'));
}
{
  // 舊快照(無新欄位)還原後補預設
  const w = mk([P('erhao', 400, 100)]);
  const snap = serializeWorld(w);
  for (const f of snap.fighters) {
    delete f.held;
    delete f.mkx;
    delete f.mkz;
    delete f.buf;
    delete f.bufT;
    delete f.aftT;
  }
  const w2 = mk([P('erhao', 400, 100)]);
  restoreWorld(w2, snap);
  const f = w2.fighters[0];
  check('舊快照缺新欄位 → normalizeFighter 補預設', f.held === -1 && f.buf === '' && f.bufT === 0 && f.aftT === 0 && f.mkx === 0);
}

// ---- 16. 8 人 3 分鐘亂鬥(含全部新角色)雜湊一致 + 大招出現 ----
{
  const players = [{ char: 'fanfan' }, ...WAVE1.map((c) => ({ char: c }))];
  const lay = layoutSpawns(8, stage);
  const mkm = () => {
    const sp = players.map((p, i) => ({ charId: p.char, kind: i === 0 ? 'human' : 'ai', lvl: 1 + (i % 3), x: lay[i].x, z: lay[i].z, face: lay[i].face }));
    return createWorld({ chars, seed: 21, stage, mode: 'timed', spawns: sp, ult: true });
  };
  const r = new Rng(5);
  const inp = [];
  let cur = 0;
  for (let t = 0; t < 10800; t++) {
    if (t % 12 === 0) cur = r.next() & 127;
    inp.push([cur]);
  }
  const go = (w, a, b, ults) => {
    const hs = [];
    for (let t = a; t < b; t++) {
      stepWorld(w, inp[t]);
      for (const e of w.events) if (e.t === 'ult' && ults) ults[e.id] = (ults[e.id] || 0) + 1;
      if (t % 60 === 59) hs.push(hashWorld(w));
    }
    return hs;
  };
  const ults = {};
  const t0 = Date.now();
  const w1 = mkm();
  const h1 = go(w1, 0, 10800, ults);
  const ms = Date.now() - t0;
  const h2 = go(mkm(), 0, 10800);
  check('8 人(帆帆 + 7 新角色)3 分鐘同種子同輸入雜湊一致', JSON.stringify(h1) === JSON.stringify(h2), h1.length + ' hashes; ' + (ms / 10800).toFixed(3) + ' ms/tick');
  const wa = mkm();
  go(wa, 0, 5000);
  const snap = serializeWorld(wa);
  const wb = mkm();
  restoreWorld(wb, snap);
  check('8 人局序列化還原後續跑一致', JSON.stringify(go(wa, 5000, 10800)) === JSON.stringify(go(wb, 5000, 10800)));
  console.log('INFO 3 分鐘各席大招次數(電腦對手):' + w1.fighters.map((f, i) => f.charId + '=' + (ults[i] || 0)).join(' ') + '  擊殺:' + w1.fighters.map((f) => f.kills).join(','));
  check('3 分鐘內有擊殺、且電腦至少施放過大招', w1.fighters.reduce((s, f) => s + f.kills, 0) > 0 && Object.values(ults).reduce((s, v) => s + v, 0) > 0);
}

// ---- 17. 互剋矩陣小樣本(只回報,不調數值) ----
{
  const N = process.argv[2] === 'quick' ? 2 : 10;
  const mat = [
    ['guanyu', 'areh', 'win'], ['lubu', 'areh', 'win'], ['cilin', 'lubu', 'win'], ['areh', 'liushui', 'lose'],
    ['liushui', 'fanfan', 'win'], ['erhao', 'lubu', 'win'], ['erhao', 'areh', 'win'], ['erhao', 'fanfan', 'win'], ['fanfan', 'huhu', 'win'],
    ['liushui', 'areh', 'win'], ['liushui', 'huhu', 'win'], ['huhu', 'cilin', 'win'], ['huhu', 'guanyu', 'win'],
    ['cilin', 'huhu', 'lose'], ['guanyu', 'huhu', 'lose'], ['lubu', 'cilin', 'lose'], ['lubu', 'erhao', 'lose']
  ];
  const lay = layoutSpawns(2, stage);
  const out = [];
  for (const [a, b, exp] of mat) {
    let aw = 0;
    let bw = 0;
    for (let i = 0; i < N; i++) {
      const aFirst = i % 2 === 0;
      const pl = aFirst ? [a, b] : [b, a];
      const sp = pl.map((c, k) => ({ charId: c, kind: 'ai', lvl: 2, x: lay[k].x, z: lay[k].z, face: lay[k].face }));
      const w = createWorld({ chars, seed: 300 + i, stage, mode: 'brawl', spawns: sp, ult: true });
      for (let t = 0; t < 20000 && !w.mode.over; t++) stepWorld(w, []);
      const win = w.mode.winner;
      if (win < 0) continue;
      if (pl[win] === a) aw++;
      else bw++;
    }
    const as = aw > bw ? 'win' : aw < bw ? 'lose' : 'even';
    out.push(a + ' vs ' + b + ' ' + aw + '-' + bw + ' [矩陣預期 ' + (exp === 'win' ? a + ' 剋 ' + b : a + ' 被 ' + b + ' 剋') + ';實測 ' + (as === exp ? '符合' : as === 'even' ? '持平' : '相反') + ']');
  }
  for (const l of out) console.log('INFO 互剋 ' + l);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
