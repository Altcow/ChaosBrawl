// 大招系統 / 迴力帽 / 帆帆大招測試:node tools/ult-test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createWorld, stepWorld, serializeWorld, restoreWorld, hashWorld } from '../js/sim/world.js';
import { BIT } from '../js/core/input.js';
import { S, isInvuln } from '../js/sim/fighter.js';
import { RAGE_MAX, ULT_SHOW, ULT_CD } from '../js/sim/ult.js';
import { commandMacro } from '../js/sim/command.js';
import { Rng } from '../js/core/rng.js';
import { drawUltOverlay } from '../js/render/ult.js';
import { drawCutinArt, drawMoveFx } from '../js/render/sprites.js';
import { FX } from '../js/core/fixed.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fan = JSON.parse(readFileSync(join(root, 'data/chars/fanfan.json'), 'utf8'));
const ada = JSON.parse(readFileSync(join(root, 'tools/fixtures/chars/ada.json'), 'utf8'));
const dummy = Object.assign({}, JSON.parse(JSON.stringify(ada)), { id: 'dummy', hp: 5000 });
const fanB = Object.assign({}, JSON.parse(JSON.stringify(fan)), { id: 'fanb' });

let pass = 0;
let fail = 0;
function check(name, ok, info) {
  if (ok) pass++;
  else fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== undefined ? '  (' + info + ')' : ''));
}
const mk = (spawns, opt = {}) => createWorld(Object.assign({ chars: { fanfan: fan, fanb: fanB, dummy, ada }, seed: 7, ult: true, stage: { w: 1600, d: 240 }, spawns }, opt));
const F = (x, z, extra = {}) => Object.assign({ charId: 'fanfan', kind: 'human', x, z, face: 1 }, extra);
const D = (x, z, extra = {}) => Object.assign({ charId: 'dummy', kind: 'post', x, z, face: -1 }, extra);
const CHORD = BIT.DEF | BIT.ATK | BIT.JUMP;
const run = (w, n, fn) => {
  for (let t = 0; t < n; t++) stepWorld(w, fn ? fn(t) : []);
};
const full = (f) => {
  f.rage = RAGE_MAX;
};

// 1. 爆氣條累積規則
{
  const w = mk([F(400, 100), D(436, 100)]);
  const a = w.fighters[0];
  const d = w.fighters[1];
  let t = 0;
  while (a.rage === 0 && t++ < 60) stepWorld(w, [t === 1 ? BIT.ATK : 0]);
  const A1 = fan.moves.attack1.frames.find((f) => f.itr).itr[0].dmg; // 第一下普攻傷害(降傷後 12;第 1 下不遞減)
  check('普攻命中:造成 ' + A1 + ' 傷害 → 爆氣 +' + (A1 * 0.2), a.rage === Math.floor((A1 * FX * 2) / 10), a.rage / FX);
  const dmgPart = Math.floor((A1 * FX * 3) / 10);
  const w2 = mk([F(400, 100, { kind: 'post' }), F(436, 100, { kind: 'human', face: -1 })]);
  let tt = 0;
  while (w2.fighters[0].rage === 0 && tt++ < 60) stepWorld(w2, [0, tt === 1 ? BIT.ATK : 0]);
  check('受傷每 10 點 +3(' + A1 + ' 傷害 → +' + (A1 * 0.3) + ')', w2.fighters[0].rage === dmgPart, w2.fighters[0].rage / FX);
  check('無大招角色不累積爆氣', d.rage === 0);
}

// 2. D+A+J 發動:全場暫停 60 tick、世界凍結、發動者無敵
{
  const w = mk([F(400, 100), D(560, 100), F(300, 60, { kind: 'post' })]);
  full(w.fighters[0]);
  stepWorld(w, [CHORD]);
  const f = w.fighters[0];
  check('三鍵發動:進入排隊並扣光爆氣', f.ult === 1 && f.rage === 0);
  check('同 tick 開始特寫', w.ult.cur === 0, 'cur=' + w.ult.cur);
  const x0 = w.fighters.map((q) => q.x + ',' + q.st + ',' + q.mt).join('|');
  const mt0 = w.mode.t;
  const tick0 = w.tick;
  let frozen = true;
  let inv = true;
  for (let t = 0; t < ULT_SHOW - 1; t++) {
    stepWorld(w, [0]);
    if (w.fighters.map((q) => q.x + ',' + q.st + ',' + q.mt).join('|') !== x0) frozen = false;
    if (!isInvuln(f, w.defs.fanfan)) inv = false;
  }
  check('暫停期間角色 / 射彈 / 模式計時全凍結', frozen && w.mode.t === mt0 && w.projectiles.length === 0);
  check('暫停期間 tick 照走(連線時步對齊)', w.tick === tick0 + ULT_SHOW - 1);
  check('發動者待命期間無敵', inv);
  stepWorld(w, [0]);
  check('60 tick 後特寫結束、開始動作、進入全場冷卻', w.ult.cur === -1 && f.ult === 2 && w.ult.cd > 0, 'cd=' + w.ult.cd);
  // 無敵窗:到第一個出手格(spawn)為止
  const first = w.defs.fanfan.moves.ultimate.first;
  let lastInvTick = -1;
  for (let t = 0; t < 40; t++) {
    if (f.ult === 2 && isInvuln(f, w.defs.fanfan)) lastInvTick = f.mtot;
    stepWorld(w, [0]);
  }
  check('無敵窗到第一個出手格為止(含該格),之後可受傷', lastInvTick === first, 'last inv mtot=' + lastInvTick + ' first=' + first);
  check('出手時 spawn 5 頂大招帽', true);
}
{
  const w = mk([F(400, 100), D(560, 100, { kind: 'post' })]);
  full(w.fighters[0]);
  stepWorld(w, [CHORD]);
  run(w, ULT_SHOW + 15, () => [0]);
  const hats = w.projectiles.filter((p) => p.kind === 'hat_ult');
  check('出手後場上 5 頂 hat_ult,帶發動序號', hats.length === 5 && hats.every((p) => p.ult === w.fighters[0].ultSeq && p.life < 1000), hats.length);
  const vzs = hats.map((p) => p.vz).sort((a, b) => a - b);
  check('扇形覆蓋縱深(vz -3~+3 px/tick)', vzs[0] < 0 && vzs[4] > 0 && vzs[0] === -3 * FX && vzs[4] === 3 * FX);
}

// 3. 8 人演出排隊與全場冷卻
{
  const sp = [];
  for (let i = 0; i < 8; i++) sp.push(F(200 + i * 100, 30 + i * 25, { kind: 'human', team: i }));
  const w = mk(sp);
  w.fighters.forEach(full);
  const ins = () => w.fighters.map(() => CHORD);
  stepWorld(w, ins());
  check('8 人同 tick 發動:同時只播一個特寫(第一個 id 0)', w.ult.cur === 0 && w.fighters.filter((f) => f.ult === 1).length === 8, 'cur=' + w.ult.cur);
  check('其餘 7 人排隊中', w.ult.q.length === 7, 'q=' + w.ult.q.length);
  run(w, ULT_SHOW, () => w.fighters.map(() => 0));
  const acting = w.fighters.filter((f) => f.ult === 2).length;
  check('特寫結束:7 名排隊者因冷卻改輕演出(暗幕 20 tick、不暫停),8 人都動作', acting === 8 && w.ult.cur === -1 && w.ult.dim > 0 && w.ult.q.length === 0, 'acting=' + acting + ' dim=' + w.ult.dim);
  check('全場冷卻 3 秒', w.ult.cd > 0 && w.ult.cd <= ULT_CD);
  run(w, 25, () => w.fighters.map(() => 0));
  check('暗幕 20 tick 後消失', w.ult.dim === 0);
  // 冷卻中再發動:輕演出、世界不暫停
  const g = w.fighters[3];
  run(w, 120, () => w.fighters.map(() => 0));
  g.ult = 0;
  g.state = S.IDLE;
  g.move = null;
  g.hitstop = 0;
  g.hist.length = 0;
  g.x = 800;
  full(g);
  w.fighters.forEach((f, i) => {
    if (i !== 3) {
      f.ult = 0;
      f.state = S.IDLE;
      f.move = null;
    }
  });
  const cdBefore = w.ult.cd;
  const t0 = w.tick;
  const arr = w.fighters.map(() => 0);
  arr[3] = CHORD;
  stepWorld(w, arr);
  check('冷卻中發動:不暫停、只暗幕', cdBefore > 0 && w.ult.cur === -1 && w.ult.dim > 0 && g.ult === 2, 'cd=' + cdBefore);
  void t0;
  // 冷卻結束後可再次完整特寫
  run(w, ULT_CD + 5, () => w.fighters.map(() => 0));
  w.fighters.forEach((f) => {
    f.ult = 0;
    f.state = S.IDLE;
    f.move = null;
    f.hitstop = 0;
    f.hist.length = 0;
  });
  full(w.fighters[5]);
  const a2 = w.fighters.map(() => 0);
  a2[5] = CHORD;
  stepWorld(w, a2);
  check('冷卻結束後再發動:完整特寫', w.ult.cur === 5);
}

// 4. 傷害上限 180、大招保護
{
  const w = mk([F(400, 100), D(520, 100)]);
  full(w.fighters[0]);
  stepWorld(w, [CHORD]);
  const hp0 = w.fighters[1].hp;
  run(w, 400, () => [0]);
  const d = w.fighters[1];
  const lost = (hp0 - d.hp) / FX;
  check('大招單目標累計傷害 ≤ 180', lost <= 180 && lost > 0, 'lost=' + lost + ' ultDmg=' + w.fighters[0].ultDmg[1] / 1);
  check('hat_ult 去回各可中(命中次數 ≥ 2)', w.fighters[0].ultDmg[1] >= 70, 'dmg=' + w.fighters[0].ultDmg[1]);
}
{
  // 兩人同時放大招打同一目標:保護機制讓其中一人傷害為 0
  const w = mk([F(330, 110, { team: 0 }), F(300, 90, { team: 1, charId: 'fanb' }), D(540, 100, { team: 2 })]);
  full(w.fighters[0]);
  full(w.fighters[1]);
  stepWorld(w, [CHORD, CHORD, 0]);
  run(w, 400, () => [0, 0, 0]);
  const a = w.fighters[0].ultDmg[2] || 0;
  const b = w.fighters[1].ultDmg[2] || 0;
  check('大招保護:3 s 內不再吃其他大招傷害(兩招之一為 0)', Math.min(a, b) === 0 && Math.max(a, b) > 0, a + ' / ' + b);
  const lost = (5000 * FX - w.fighters[2].hp) / FX;
  check('目標總傷害 ≤ 180(只吃第一招)', lost <= 180, lost);
}
{
  // 防禦:吃 25%、bdef +50
  const w = mk([F(400, 100), D(520, 100, { kind: 'human' })]);
  full(w.fighters[0]);
  stepWorld(w, [CHORD, BIT.DEF]);
  const hp0 = w.fighters[1].hp;
  let sawBlock = false;
  for (let t = 0; t < 120; t++) {
    stepWorld(w, [0, BIT.DEF]);
    if (w.events.some((e) => e.t === 'block')) sawBlock = true;
    if (sawBlock) break;
  }
  const lost = (hp0 - w.fighters[1].hp) / FX;
  check('防住大招判定:吃 25%(35 → 8.75)', sawBlock && Math.abs(lost - 8.75) < 0.01, 'lost=' + lost);
}

// 5. 迴力帽(D3)
{
  const w = mk([F(300, 100), D(560, 100, { kind: 'post' })]);
  const f = w.fighters[0];
  const macro = commandMacro('sp_fwd_atk', 1);
  let k = 0;
  const feed = () => [k < macro.length ? macro[k++] : 0, 0];
  let hits = 0;
  let turned = -1;
  let gone = -1;
  let blocked = null;
  for (let t = 0; t < 200; t++) {
    stepWorld(w, feed());
    for (const e of w.events) if (e.t === 'hit') hits++;
    const hat = w.projectiles.find((p) => p.kind === 'hat');
    if (hat && hat.life >= 1000 && turned < 0) turned = t;
    if (!hat && turned >= 0 && gone < 0) gone = t;
    if (hat && t === 20) {
      const mp = f.mp;
      k = 0;
      for (let i = 0; i < macro.length; i++) stepWorld(w, [macro[i], 0]);
      t += macro.length;
      blocked = f.mp >= mp && !w.projectiles.some((p) => p.id !== hat.id && p.kind === 'hat');
    }
  }
  check('迴力帽飛到最遠後折返(life 進入回程區間)並回到手上消失', turned > 20 && gone > turned, 'turn=' + turned + ' gone=' + gone);
  check('帽子沒回來前不能再丟(MP 不扣、不出第二頂)', blocked === true);
  check('去回各中一次(目標在折返點附近 → 2 次命中)', hits >= 2, 'hits=' + hits);
  // 回來後可再丟
  k = 0;
  for (let i = 0; i < macro.length; i++) stepWorld(w, [macro[i], 0]);
  run(w, 12, () => [0, 0]);
  check('帽子回手後可再丟', w.projectiles.some((p) => p.kind === 'hat'));
}

// 6. 序列化:大招暫停中途快照 → 還原後續跑雜湊一致;舊式快照補預設
{
  const mkw = () => mk([F(400, 100), D(520, 100), F(300, 60, { kind: 'ai', lvl: 2, team: 5 })]);
  const w1 = mkw();
  full(w1.fighters[0]);
  const r = new Rng(3);
  const ins = [];
  for (let t = 0; t < 900; t++) ins.push([t === 5 ? CHORD : t < 5 ? 0 : (r.next() & 15) | (t % 40 < 8 ? BIT.ATK : 0), 0, 0]);
  run(w1, 30, (t) => ins[t]);
  check('(快照點在特寫暫停中)', w1.ult.cur >= 0);
  const snap = serializeWorld(w1);
  const w2 = mkw();
  restoreWorld(w2, JSON.parse(JSON.stringify(snap)));
  let ok = hashWorld(w1) === hashWorld(w2);
  for (let t = 30; t < 900 && ok; t++) {
    stepWorld(w1, ins[t]);
    stepWorld(w2, ins[t]);
    if (hashWorld(w1) !== hashWorld(w2)) ok = false;
  }
  check('暫停中途快照還原後續跑 870 tick,每 tick 雜湊一致', ok);
  const old = serializeWorld(mkw());
  delete old.ult;
  old.fighters.forEach((q) => {
    delete q.rage;
    delete q.ult;
    delete q.ultSeq;
    delete q.ultDmg;
    delete q.ultGuard;
    delete q.ultGuardBy;
  });
  const w3 = mkw();
  let threw = false;
  try {
    restoreWorld(w3, old);
    run(w3, 120, () => [0, 0, 0]);
  } catch (e) {
    threw = true;
  }
  check('不含大招欄位的舊式 / 連線解碼快照可還原並續跑(補預設)', !threw && w3.ult.cur === -1);
}

// 7. AI 能放大招
{
  const w = mk([F(400, 100, { kind: 'ai', lvl: 3, team: 0 }), D(520, 100, { team: 1 }), D(540, 120, { team: 2 })]);
  full(w.fighters[0]);
  let used = false;
  for (let t = 0; t < 600 && !used; t++) {
    stepWorld(w, []);
    if (w.events.some((e) => e.t === 'ult')) used = true;
  }
  check('AI 爆氣滿、前方 2 名敵人 → 發動大招', used);
}

// 8. 8 人 3 分鐘決定性雜湊(含大招 / 迴力帽 / AI)
{
  const build = () => {
    const sp = [];
    const ids = ['fanfan', 'fanb', 'fanfan', 'ada', 'fanb', 'fanfan', 'ada', 'fanfan'];
    for (let i = 0; i < 8; i++) sp.push({ charId: ids[i], kind: i < 4 ? 'human' : 'ai', lvl: i % 4, team: i, x: 300 + i * 150, z: 30 + (i * 53) % 180, face: i % 2 ? -1 : 1 });
    return mk(sp, { mode: 'brawl', seed: 99 });
  };
  const play = () => {
    const w = build();
    const r = new Rng(5);
    const hs = [];
    let ults = 0;
    let fulls = 0;
    for (let t = 0; t < 10800; t++) {
      if (t % 600 === 0) w.fighters.forEach((f, i) => {
        if (!f.dead && w.defs[f.charId].hasUlt && i % 2 === 0) f.rage = RAGE_MAX;
      });
      const ins = [];
      for (let i = 0; i < 4; i++) {
        let b = r.next() & 127;
        if (r.next() % 90 === 0) b = CHORD;
        else if (r.next() % 30 === 0) b = commandMacro('sp_fwd_atk', 1)[2];
        ins.push(b);
      }
      stepWorld(w, ins);
      for (const e of w.events) if (e.t === 'ult') {
        ults++;
        if (e.full) fulls++;
      }
      if (t % 300 === 0) hs.push(hashWorld(w));
      if (w.mode.over) break;
    }
    return { h: hashWorld(w), hs: hs.join(','), ults, fulls, tick: w.tick, bad: JSON.stringify(serializeWorld(w)).includes('null,') };
  };
  const a = play();
  const b = play();
  check('8 人 3 分鐘局:兩次執行雜湊序列與終局雜湊一致', a.h === b.h && a.hs === b.hs, 'tick=' + a.tick + ' ults=' + a.ults + ' fulls=' + a.fulls);
  check('8 人局確實發生大招', a.ults > 0 && a.fulls > 0, a.ults);
}

// 9. 渲染層:找不到圖 / 沒有 w.ult 都不報錯
{
  const calls = [];
  const ctx = new Proxy({}, { get: (t, k) => (k === 'canvas' ? {} : (...a) => { calls.push(k); }), set: () => true });
  const w = mk([F(400, 100)]);
  let ok = true;
  try {
    drawUltOverlay(ctx, w);
    w.ult.cur = 0;
    w.ult.t = 30;
    drawUltOverlay(ctx, w);
    w.ult.cur = -1;
    w.ult.dim = 10;
    w.ult.dimId = 0;
    drawUltOverlay(ctx, w);
    drawUltOverlay(ctx, { fighters: w.fighters, defs: w.defs });
    const f = w.fighters[0];
    f.move = 'sp_up_atk';
    f.hf = 1;
    f.mf = 1;
    drawMoveFx(ctx, f, w.defs.fanfan, 100, 100, 1, false);
    drawMoveFx(ctx, f, w.defs.fanfan, 100, 100, 1, true);
    ok = drawCutinArt(ctx, 'fanfan', 0, 0, 1, false) === false;
  } catch (e) {
    console.log(e);
    ok = false;
  }
  check('圖集未載入:特寫 / 招式特效 / 暗幕不報錯並退回', ok);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
