// 第 1 波 7 角色 + D 系列新機制測試:node tools/chars-test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createWorld, stepWorld, serializeWorld, restoreWorld, hashWorld } from '../js/sim/world.js';
import { layoutSpawns } from '../js/sim/modes.js';
import { BIT, STEP_BYTE } from '../js/core/input.js';
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
const DORMANT = ['cilin', 'huhu', 'liushui', 'erhao']; // 已從 index 拿掉、檔案保留以便還原;仍載入以維持原有覆蓋
for (const id of DORMANT) chars[id] = load(id);
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
  check('index.json:fanfan / areh / guanyu / lubu / magnet / sun + 新 6 位(piggy qiyu xiaozhi kenan longjuan manman),共 12 人(cilin / huhu / liushui / erhao 已作廢,檔案保留)', JSON.stringify(ids) === JSON.stringify(['fanfan', 'areh', 'guanyu', 'lubu', 'magnet', 'sun', 'piggy', 'qiyu', 'xiaozhi', 'kenan', 'longjuan', 'manman']), ids.join(','));
  const NEW6 = { piggy: [490, 2.6, 1.6, 5.8, 1.0], qiyu: [520, 2.0, 1.3, 4.8, 0.9], xiaozhi: [470, 2.5, 1.5, 5.5, 1.0], kenan: [450, 2.5, 1.6, 5.6, 1.0], longjuan: [430, 2.4, 1.5, 5.0, 0.9], manman: [530, 2.1, 1.3, 4.8, 0.9] };
  for (const [id, v] of Object.entries(NEW6)) {
    const j = chars[id];
    check(id + ' 新角色基本資料(HP / 走 / 跑符合設計文件 1-3 節;3 招必殺 + 最強必殺技)', j && j.hp === v[0] && j.walk.x === v[1] && j.walk.z === v[2] && j.run.x === v[3] && j.run.z === v[4] && Object.keys(j.moves).filter((m) => /^sp_/.test(m)).length === 3 && !!j.moves.ultimate, j && j.name);
  }
  for (const id of WAVE1) {
    const j = chars[id];
    const w = mk([P(id, 400, 100)]);
    const def = w.defs[id];
    check(id + ' 資料:nicknames 8 個、color、有大招、HP 在 420~600', j.nicknames.length === 8 && /^#[0-9a-f]{6}$/i.test(j.color) && def.hasUlt && j.hp >= 420 && j.hp <= 600, j.name + ' hp=' + j.hp);
    check(id + ' 資料:無 art 欄位(色塊佔位;areh / guanyu / lubu 已接通用動作圖例外)、ai.style / specials / ult 皆有', (!j.art || id === 'areh' || id === 'guanyu' || id === 'lubu') && j.ai.style && j.ai.specials.length >= 2 && j.ai.ult, '');
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
  check('轅門射戟:穿透一路 3 人各中一次', [1, 2, 3].every((i) => lost(w, i) === 48), [1, 2, 3].map((i) => lost(w, i)).join(','));
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
const NEW6 = ['piggy', 'qiyu', 'xiaozhi', 'kenan', 'longjuan', 'manman'];
for (const id of WAVE1.concat(NEW6)) {
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

// ---- 18. 新 6 角色必殺技(docs/必殺技設計_新6角色.md)+ E1~E4 ----
{
  for (const id of NEW6) {
    const j = chars[id];
    const sp = Object.keys(j.moves).filter((m) => /^sp_/.test(m));
    check(id + ' 資料:3 招必殺 + 最強、info / ai.specials / ai.ult / assist 齊全', sp.length === 3 && j.info.ult && j.ai.specials.length === 3 && j.ai.ult && j.assist && sp.every((c) => j.info.moves[c] && j.ai.specials.some((a) => a.cmd === c)), sp.join(','));
  }
  const casting = (id, others, cmd) => {
    const w = mk([P(id, 400, 100), ...others]);
    w.fighters[0].mp = 500 * FX;
    cast(w, cmd);
    return w;
  };
  const RIGHT = () => [BIT.RIGHT, 0, 0, 0, 0, 0, 0, 0];
  // 小豬豬
  {
    const w = casting('piggy', [D(440, 100), D(360, 100, { team: 5 })], 'sp_fwd_atk');
    run(w, 120, nil);
    check('雙刀亂剁:前後都打(前方 96、身後 60,最後交叉斬只打前方)', lost(w, 1) === 96 && lost(w, 2) === 60, lost(w, 1) + '/' + lost(w, 2));
    const w2 = casting('piggy', [D(450, 100), D(550, 100, { team: 5 }), D(650, 100, { team: 6 })], 'sp_fwd_jump');
    run(w2, 120, nil);
    check('豬突猛進:路上 3 人各中 60 一次', [1, 2, 3].every((i) => lost(w2, i) === 60), [1, 2, 3].map((i) => lost(w2, i)).join(','));
    const w3 = casting('piggy', [D(430, 100)], 'sp_up_atk');
    run(w3, 120, nil);
    check('旋風豬上天:空中旋轉總傷害約 61(40~70)', lost(w3, 1) >= 40 && lost(w3, 1) <= 70, lost(w3, 1));
    const wu = mk([P('piggy', 400, 100), D(440, 100)]);
    full(wu.fighters[0]);
    ult(wu);
    const x0 = wu.fighters[0].x;
    run(wu, 130, RIGHT);
    check('山大王大暴走:方向鍵可操控(往右 > 300 px)、單目標 ≤ 160', (wu.fighters[0].x - x0) / FX > 300 && lost(wu, 1) <= 160 && lost(wu, 1) > 0, 'dx=' + (((wu.fighters[0].x - x0) / FX) | 0) + ' lost=' + lost(wu, 1));
    const wi = mk([P('piggy', 400, 100), D(1000, 100)]);
    full(wi.fighters[0]);
    ult(wi);
    run(wi, 45, nil);
    takeHit(wi, wi.fighters[0], wi.fighters[0].x + 30 * FX, fakeItr({ fall: 20 }), 1, true);
    check('山大王大暴走:沒有霸體,被射彈打中就中斷', wi.fighters[0].move === null);
  }
  // 騎玉
  {
    const w = casting('qiyu', [D(440, 100)], 'sp_fwd_atk');
    run(w, 120, nil);
    check('隨便連打:9 連拳 + 直拳 = 99', lost(w, 1) === 99, lost(w, 1));
    const w2 = mk([P('qiyu', 400, 100), D(1300, 100), D(1000, 160, { team: 5 }), D(1000, 100, { team: 6 })]);
    full(w2.fighters[0]);
    ult(w2);
    let shake = 0;
    for (let t = 0; t < 120; t++) {
      stepWorld(w2, nil());
      shake += w2.events.filter((e) => e.t === 'shake').length;
    }
    check('玩真的一拳:前方 900 px 外也打得到 160、縱深錯開 60 閃得掉、E3 發出畫面震動事件', lost(w2, 1) === 160 && lost(w2, 2) === 0 && lost(w2, 3) === 160 && shake === 1, lost(w2, 1) + '/' + lost(w2, 2) + '/' + lost(w2, 3) + ' shake=' + shake);
    const w3 = mk([P('qiyu', 400, 100), D(440, 100)]);
    w3.fighters[0].mp = 500 * FX;
    cast(w3, 'sp_fwd_jump');
    let invT = 0;
    for (let t = 0; t < 40; t++) {
      stepWorld(w3, nil());
      if (isInvuln(w3.fighters[0], w3.defs.qiyu)) invT++;
    }
    check('體育課反覆橫跳:前 16 tick 無敵', invT >= 12 && invT <= 17, invT);
  }
  // 小志
  {
    const w = casting('xiaozhi', [D(600, 100)], 'sp_fwd_atk');
    run(w, 100, nil);
    check('劈哩啪啦:閃電 48、硬直 30(長於一般)', lost(w, 1) === 48 && w.fighters[1].stunT === 30, lost(w, 1) + ' stun=' + w.fighters[1].stunT);
    const w2 = casting('xiaozhi', [D(450, 100)], 'sp_fwd_jump');
    run(w2, 140, nil);
    check('消防水柱:共 71(連續推擠 + 最後擊倒)', lost(w2, 1) === 71, lost(w2, 1));
    const w3 = casting('xiaozhi', [D(480, 100)], 'sp_down_atk');
    let hurt = 0;
    for (let t = 0; t < 150; t++) {
      stepWorld(w3, nil());
      if (w3.fighters[1].state === S.HURT) hurt++;
    }
    check('藤蔓絆腳:纏住約 60 tick、24 傷害、陷阱踩中後消失', hurt >= 58 && hurt <= 66 && lost(w3, 1) === 24 && w3.projectiles.length === 0, 'hurt=' + hurt);
    const w4 = mk([P('xiaozhi', 400, 100), D(900, 100), D(1100, 100, { team: 5 })]);
    full(w4.fighters[0]);
    ult(w4);
    run(w4, 220, nil);
    check('爆炎大俯衝:龍橫越畫面穿透,兩人各 150', lost(w4, 1) === 150 && lost(w4, 2) === 150, lost(w4, 1) + '/' + lost(w4, 2));
    const w5 = mk([P('xiaozhi', 400, 100), D(900, 100)]);
    full(w5.fighters[0]);
    ult(w5);
    run(w5, 70, nil);
    const f5 = w5.fighters[0];
    f5.hitstop = 0;
    const had = w5.projectiles.length === 1;
    takeHit(w5, f5, f5.x + 30 * FX, fakeItr({ fall: 100 }), 1, false);
    stepWorld(w5, nil());
    check('爆炎大俯衝:龍飛出後小志被打倒,龍仍在', had && w5.projectiles.some((p) => p.kind === 'dragon'));
  }
  // 柯南
  {
    const w = casting('kenan', [D(700, 100)], 'sp_fwd_atk');
    run(w, 80, nil);
    check('強力射門:足球 60 擊倒', lost(w, 1) === 60, lost(w, 1));
    const w2 = casting('kenan', [D(550, 100), D(500, 160, { team: 5 }), D(380, 100, { team: 6 })], 'sp_fwd_jump');
    run(w2, 40, nil);
    check('伸縮皮帶:前方 220 px 內拉到身前 30 px、不傷害;縱深外與身後的人不受影響', Math.abs((w2.fighters[1].x - w2.fighters[0].x) / FX - 30) <= 1 && lost(w2, 1) === 0 && w2.fighters[2].x === 500 * FX && w2.fighters[3].x === 380 * FX);
    const w3 = casting('kenan', [D(600, 100), D(600, 130, { team: 5 })], 'sp_down_atk');
    let hurt = 0;
    for (let t = 0; t < 160; t++) {
      stepWorld(w3, nil());
      if (w3.fighters[1].state === S.HURT) hurt++;
    }
    check('麻痺飛針:命中 12、麻痺約 75 tick;縱深錯開 30 閃得掉(zr 8)', lost(w3, 1) === 12 && hurt >= 73 && hurt <= 82 && lost(w3, 2) === 0, 'hurt=' + hurt);
    const w4 = mk([P('kenan', 400, 100), D(800, 100), D(1100, 100, { team: 5 })]);
    full(w4.fighters[0]);
    ult(w4);
    run(w4, 220, nil);
    check('破案大射門:巨球穿透,兩人各 140', lost(w4, 1) === 140 && lost(w4, 2) === 140, lost(w4, 1) + '/' + lost(w4, 2));
  }
  // 籠卷
  {
    const w = casting('longjuan', [D(700, 100), D(900, 100, { team: 5 })], 'sp_fwd_atk');
    run(w, 100, nil);
    check('翠綠旋風刃:360 px 內命中 42、更遠不中', lost(w, 1) === 42 && lost(w, 2) === 0, lost(w, 1));
    const w2 = casting('longjuan', [D(470, 100), D(700, 100, { team: 5 })], 'sp_fwd_jump');
    let held = 0;
    for (let t = 0; t < 150; t++) {
      stepWorld(w2, nil());
      if (w2.fighters[1].held === 0) held++;
    }
    check('念力擒拋:抓到 → 釘住約 24 tick;被抓者共 78(24 + 18 + 36);丟出路上的人 36', held >= 22 && held <= 28 && lost(w2, 1) === 78 && lost(w2, 2) === 36, 'held=' + held + ' ' + lost(w2, 1) + '/' + lost(w2, 2));
    const w3 = casting('longjuan', [D(1000, 100)], 'sp_fwd_jump');
    let n = 0;
    for (let t = 0; t < 100; t++) {
      stepWorld(w3, nil());
      if (w3.fighters[0].move) n++;
    }
    check('念力擒拋:揮空約 42 tick 破綻、不鎖定', n >= 38 && n <= 46 && w3.fighters[1].held === -1, n);
    const w3b = casting('longjuan', [D(470, 100)], 'sp_fwd_jump');
    w3b.fighters[1].state = S.DEFEND;
    w3b.fighters[1].face = -1;
    let sawHeld = false;
    for (let t = 0; t < 30; t++) {
      stepWorld(w3b, nil());
      if (w3b.fighters[1].held === 0) sawHeld = true;
    }
    check('念力擒拋:不可防(防禦姿勢也被抓)', sawHeld && lost(w3b, 1) >= 20, lost(w3b, 1));
    const w4 = casting('longjuan', [D(470, 100)], 'sp_up_atk');
    run(w4, 150, nil);
    check('迷你龍捲:捲上天連續 4 下共 56', lost(w4, 1) === 56, lost(w4, 1));
    const w5 = mk([P('longjuan', 400, 100), D(560, 100)]);
    full(w5.fighters[0]);
    ult(w5);
    run(w5, 300, nil);
    check('翡翠大龍捲:連續受傷、單目標 ≤ 150', lost(w5, 1) >= 90 && lost(w5, 1) <= 150, lost(w5, 1));
    check('E1:念力擒拋鎖定招式帶 holdDy(被抓者畫面抬高),其他角色的鎖定招式沒有', w5.defs.longjuan.moves.psy_lock.holdDy > 0 && w5.defs.longjuan.moves.psy_lock.lock && !w5.defs.areh.moves.ultimate_lock.holdDy);
  }
  // 漫漫龜
  {
    const w = casting('manman', [D(600, 100)], 'sp_fwd_atk');
    let out = 0;
    for (let t = 0; t < 220; t++) {
      stepWorld(w, nil());
      if (w.projectiles.length) out = t;
    }
    check('龜殼滑球:去程 + 回程各打一次(共 84),滑回來後消失', lost(w, 1) === 84 && out > 60 && out < 160 && w.projectiles.length === 0, lost(w, 1) + ' out=' + out);
    const w2 = casting('manman', [D(500, 100), D(700, 100, { team: 5 })], 'sp_fwd_jump');
    const m2 = w2.fighters[0];
    let invT = 0;
    for (let t = 0; t < 120; t++) {
      stepWorld(w2, RIGHT());
      if (isInvuln(m2, w2.defs.manman) && m2.move) invT++;
    }
    check('星星糖無敵衝:48 tick 無敵、方向鍵可操控、撞到的人各 42', invT >= 46 && invT <= 56 && lost(w2, 1) === 42 && lost(w2, 2) === 42, 'inv=' + invT + ' ' + lost(w2, 1) + '/' + lost(w2, 2));
    const wq = casting('manman', [D(900, 100)], 'sp_fwd_jump');
    const xq = wq.fighters[0].x;
    run(wq, 8, RIGHT);
    check('steer 招式:標 still 的吃糖格不吃方向鍵(吃糖期間按住方向鍵不位移)', wq.fighters[0].x === xq);
    const w3 = casting('manman', [D(430, 100)], 'sp_down_atk');
    run(w3, 10, nil);
    const f3 = w3.fighters[0];
    const r = takeHit(w3, f3, f3.x + 30 * FX, fakeItr({ fall: 20 }), 1, false);
    run(w3, 60, nil);
    check('縮頭烏龜:近戰碰到 → 殼旋轉反擊 54', r === 'counter' && lost(w3, 1) === 54, r + ' ' + lost(w3, 1));
    check('縮頭烏龜:架式格 reflect(射彈原路彈回)', w3.defs.manman.moves.sp_down_atk.frames[0].reflect);
    // 改版:從漫漫身上向外擴散的震波(半徑 700 px、30 tick 擴到最遠),不可防;範圍外、翻滾抓時機、倒地者不吃
    const w4 = mk([P('manman', 400, 100), D(600, 100), D(1150, 100, { team: 5 }), D(1000, 100, { team: 6 }), D(300, 100, { team: 7 })]);
    w4.fighters[4].state = S.LYING;
    w4.fighters[4].st = -300; // 躺到震波過去(測「倒地不吃」)
    full(w4.fighters[0]);
    ult(w4);
    run(w4, 200, nil);
    check('星光殼大地震:700 px 內地面敵人各 70(200 / 600 px);範圍外(750 px)與倒地者不吃', lost(w4, 1) === 70 && lost(w4, 3) === 70 && lost(w4, 2) === 0 && lost(w4, 4) === 0, [1, 2, 3, 4].map((i) => lost(w4, i)).join('/'));
    {
      // 震波是「掃過」的:近的先中、遠的後中(依距離排時間)
      const wt = mk([P('manman', 400, 100), D(500, 100, { team: 5 }), D(1000, 100, { team: 6 })]);
      full(wt.fighters[0]);
      ult(wt);
      let t1 = -1;
      let t2 = -1;
      for (let t = 0; t < 120; t++) {
        stepWorld(wt, nil());
        if (t1 < 0 && lost(wt, 1) > 0) t1 = t;
        if (t2 < 0 && lost(wt, 2) > 0) t2 = t;
      }
      check('大地震:震波由近而遠擴散(100 px 處 vs 600 px 處,相差約 25 tick)', t1 >= 0 && t2 > t1 + 18 && t2 - t1 < 30, 't1=' + t1 + ' t2=' + t2);
      // 翻滾抓時機:掃描翻滾起始 tick,應同時存在「躲掉」與「吃到」(時機窗有限,不是永遠躲得掉)
      let dodged = 0;
      let got = 0;
      for (let s = 30; s <= 60; s++) {
        const wr = mk([P('manman', 400, 100), P('ada', 500, 100, { team: 5, face: -1 })]);
        wr.fighters[1].hp = 5000 * FX;
        wr.fighters[1].mp = 0;
        full(wr.fighters[0]);
        ult(wr);
        const hp0 = wr.fighters[1].hp;
        for (let t = 0; t < 120; t++) {
          const arr = nil();
          if (t === s) arr[1] = BIT.DEF | BIT.RIGHT;
          stepWorld(wr, arr);
        }
        if (wr.fighters[1].hp < hp0) got++;
        else dodged++;
      }
      check('大地震:翻滾抓時機可躲(掃描起始 tick:有躲掉的、也有吃到的)', dodged >= 2 && got >= 10, 'dodged=' + dodged + ' got=' + got);
      // 跑出範圍 / 後滑:震波擴散(30 tick 內 700 px,約 23 px/tick)比跑速快,所以只能靠「起手 50 tick」先拉開;實測 d0 ≥ 約 250 px 的人往外跑才逃得出,
      // 100 px 內的人連後滑 4 段(拉開 440 px)也只能晚幾 tick 才被掃到(與設計文件 4-6「≥100 px 逃得出」不符,見回報)
      const escape = (d0, mode) => {
        const we = mk([P('manman', 300, 100), P('ada', 300 + d0, 100, { team: 5, face: -1 })]);
        we.fighters[1].mp = 0;
        const fl = we.fighters[1];
        const hp0 = fl.hp;
        ult(we); // 排隊 + 跑完 60 tick 特寫暫停;這之後起手還剩 50 tick 才放震波
        const press = { 0: 1, 10: 1, 22: 1, 34: 1 }; // 後滑 4 段(段長 12 tick,第 6 tick 後可接)
        let hitT = -1;
        for (let t = 0; t < 200; t++) {
          const a = nil();
          if (mode === 'run') a[1] = t === 1 ? 0 : BIT.RIGHT; // 雙擊右 → 跑
          else if (mode === 'step') a[1] = press[t] ? STEP_BYTE.back : t === 64 || t > 65 ? BIT.RIGHT : 0; // 後滑 4 段、16 tick 喘完再跑
          stepWorld(we, a);
          if (hitT < 0 && fl.hp < hp0) hitT = t;
        }
        return hitT;
      };
      const e300 = escape(300, 'run');
      const e600 = escape(600, 'run');
      const e100r = escape(100, 'run');
      const e100s = escape(100, 'step');
      const e100w = escape(100, 'walk');
      check('大地震:往外跑可逃出震波(300 / 600 px 起跑,場地夠寬)', e300 < 0 && e600 < 0, e300 + '/' + e600);
      check('大地震:100 px 內被掃到(後滑 4 段只是晚被掃到;不動最早)', e100r >= 0 && e100s > e100r && e100w >= 0 && e100w <= e100r, 'run=' + e100r + ' step=' + e100s + ' stand=' + e100w);
    }
  }
  // E4 控制遞減
  {
    const w = mk([P('kenan', 400, 100), D(700, 100)]);
    const d = w.fighters[1];
    const itr = (o) => fakeItr(Object.assign({ fall: 0, stun: 60, dmg: 1 }, o));
    takeHit(w, d, 600 * FX, itr(), 0, true);
    const first = d.stunT;
    d.state = S.IDLE;
    d.hitstop = 0;
    run(w, 30, nil);
    takeHit(w, d, 600 * FX, itr(), 0, true);
    const second = d.stunT;
    d.state = S.IDLE;
    d.hitstop = 0;
    run(w, 200, nil);
    takeHit(w, d, 600 * FX, itr(), 0, true);
    const third = d.stunT;
    d.state = S.IDLE;
    d.hitstop = 0;
    takeHit(w, d, 600 * FX, itr({ stun: 20 }), 0, true);
    const short = d.stunT;
    check('E4 控制遞減:長硬直 60 → 3 s 內第二次減半 30 → 超過 3 s 恢復 60;短硬直(20)不受影響', first === 60 && second === 30 && third === 60 && short === 20, first + '/' + second + '/' + third + '/' + short);
    const w2 = mk([P('kenan', 400, 100), D(700, 100)]);
    const d2 = w2.fighters[1];
    takeHit(w2, d2, 600 * FX, fakeItr({ fall: 0, stun: 10, kind: 'grab', lock: 'x' }), 0, false);
    d2.state = S.IDLE;
    d2.hitstop = 0;
    takeHit(w2, d2, 600 * FX, itr(), 0, true);
    check('E4:擒抓(lock)刷新計時,之後 3 s 內的長硬直減半', d2.stunT === 30, d2.stunT);
    const snap = serializeWorld(w2);
    const w3 = mk([P('kenan', 400, 100), D(700, 100)]);
    restoreWorld(w3, snap);
    check('E4:ctlT 進快照 / 還原', w3.fighters[1].ctlT === w2.fighters[1].ctlT && w3.fighters[1].ctlT > 0);
  }
  // 8 人新角色混戰 3 分鐘:雜湊一致、電腦出過必殺
  {
    const lay = layoutSpawns(8, stage);
    const list = ['piggy', 'qiyu', 'xiaozhi', 'kenan', 'longjuan', 'manman', 'fanfan', 'sun'];
    const mkm = () => createWorld({ chars, seed: 33, stage, mode: 'timed', ult: true, spawns: list.map((c, i) => ({ charId: c, kind: 'ai', lvl: 2 + (i % 2), x: lay[i].x, z: lay[i].z, face: lay[i].face })) });
    const used = {};
    const go = (w) => {
      const hs = [];
      for (let t = 0; t < 10800; t++) {
        stepWorld(w, []);
        for (const f of w.fighters) if (f.move && /^sp_|^ultimate/.test(f.move)) used[f.charId + ':' + f.move] = 1;
        if (t % 120 === 119) hs.push(hashWorld(w));
      }
      return hs;
    };
    const h1 = go(mkm());
    const h2 = go(mkm());
    const names = Object.keys(used);
    const need = (c) => Object.keys(chars[c].moves).filter((m) => /^sp_|^ultimate$/.test(m)).filter((m) => !used[c + ':' + m]);
    const miss = NEW6.filter((c) => need(c).length).map((c) => c + '(' + need(c).join('/') + ')');
    check('新 6 角色 8 人電腦混戰 3 分鐘:雜湊一致、每位電腦 4 招(3 必殺 + 最強)都用過', JSON.stringify(h1) === JSON.stringify(h2) && miss.length === 0, 'unused=' + miss.join(',') + ' used=' + names.length);
  }
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
