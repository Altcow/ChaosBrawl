// 月步 / 取消跳躍 / 普攻遞減 / MP 經濟 / codec 新欄位 測試:node tools/step-test.mjs
// (手機滑動出招改版的引擎層;設計見 docs/手機滑動出招設計.md,介面見 docs/引擎介面.md)
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createWorld, stepWorld, serializeWorld, restoreWorld, hashWorld } from '../js/sim/world.js';
import { resolveHits } from '../js/sim/hit.js';
import { BIT, STEP_BYTE } from '../js/core/input.js';
import { S, takeHit, stepPower, STEP_SPEC } from '../js/sim/fighter.js';
import { RAGE_MAX, ULT_MACRO } from '../js/sim/ult.js';
import { commandMacro, stepMacro } from '../js/sim/command.js';
import { makeCtx, encodeWorld, decodeWorld, encodeDelta, applyDelta } from '../js/net/codec.js';
import { Rng } from '../js/core/rng.js';
import { FX } from '../js/core/fixed.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ld = (p) => JSON.parse(readFileSync(join(root, p), 'utf8'));
const ada = ld('tools/fixtures/chars/ada.json');
const ada0 = Object.assign(JSON.parse(JSON.stringify(ada)), { id: 'ada0' }); // 普攻 gain 設 0:驗證全域「前 3 下 +4 MP」
for (const m of ['attack1', 'attack2', 'attack3']) for (const f of ada0.moves[m].frames) if (f.itr) for (const i of f.itr) i.gain = 0;
const dummy = Object.assign(JSON.parse(JSON.stringify(ada)), { id: 'dummy', hp: 5000 });
const fan = ld('data/chars/fanfan.json');
const ids = ld('data/chars/index.json');
const real = {};
for (const id of ids) real[id] = ld('data/chars/' + id + '.json');
const chars = { ada, ada0, dummy, fanfan: fan };

let pass = 0;
let fail = 0;
function check(name, ok, info) {
  if (ok) pass++;
  else fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== undefined ? '  (' + info + ')' : ''));
}
const mk = (spawns, opt = {}) => createWorld(Object.assign({ chars, seed: 5, ult: true, stage: { w: 1600, d: 240 }, spawns }, opt));
const P = (charId, x, z, extra = {}) => Object.assign({ charId, kind: 'human', x, z, face: 1 }, extra);
const px = (v) => v / FX;
const S0 = BIT.STEP;
// 依 tick 表輸入單人:script[t] = 位元組(沒列 = 0)
function play(w, script, n, seat = 0, others = 0) {
  for (let t = 0; t < n; t++) {
    const arr = new Array(w.fighters.length).fill(others);
    arr[seat] = script[t] || 0;
    stepWorld(w, arr);
  }
}

// ---- 1. 單段距離 ----
{
  const kinds = [['fwd', 150, 0], ['back', -110, 0], ['up', 0, -60], ['down', 0, 60]];
  for (const [k, dx, dz] of kinds) {
    const w = mk([P('ada', 400, 100)]);
    const f = w.fighters[0];
    play(w, { 0: STEP_BYTE[k] }, 40);
    const okPos = Math.abs(px(f.x) - (400 + dx)) <= 1 && Math.abs(px(f.z) - (100 + dz)) <= 1;
    check('月步單段 ' + k + ':位移 dx=' + dx + ' dz=' + dz + '、回到待機、面向不變', okPos && f.state === S.IDLE && f.face === 1, 'x=' + px(f.x) + ' z=' + px(f.z) + ' state=' + f.state);
  }
  const w = mk([P('ada', 800, 100, { face: -1 })]);
  play(w, { 0: STEP_BYTE.fwd }, 30);
  check('面向左時前衝往左、後滑往右(依 face 解讀)', Math.abs(px(w.fighters[0].x) - 650) <= 1);
  const w2 = mk([P('ada', 800, 100, { face: -1 })]);
  play(w2, { 0: STEP_BYTE.back }, 30);
  check('面向左的後滑往右 110 px', Math.abs(px(w2.fighters[0].x) - 910) <= 1);
  // 無敵時間無:移動中被打得到
  const w3 = mk([P('ada', 400, 100)]);
  play(w3, { 0: STEP_BYTE.fwd }, 6);
  check('月步無無敵(步中 isInvuln = false)', w3.fighters[0].state === S.STEP);
}

// ---- 2. 連踏 / 上限 / 步力 / 破綻 ----
{
  const w = mk([P('ada', 200, 100)]);
  const f = w.fighters[0];
  const press = { 0: S0, 10: S0, 20: S0, 30: S0, 40: S0 }; // 第 5 次超過連續上限(4 段)
  let seg4End = -1;
  let breathEnd = -1;
  for (let t = 0; t < 120; t++) {
    const arr = [press[t] || 0];
    stepWorld(w, arr);
    if (t === 39) seg4End = px(f.x);
    if (breathEnd < 0 && t > 40 && f.state === S.IDLE) breathEnd = t;
  }
  check('前衝連 4 段 = 600 px / 40 tick(0.67 秒)', Math.abs(seg4End - 800) <= 1, 'x@39=' + seg4End);
  check('連續上限 4 段:第 5 次輸入不再前進(終點仍 800)', Math.abs(px(f.x) - 800) <= 1, 'final x=' + px(f.x));
  check('連 4 段後步力歸零,且收招 16 tick 破綻(約 tick 56 才回待機)', breathEnd >= 55 && breathEnd <= 58, 'breathEnd=' + breathEnd);
}
{
  // 破綻期間不能取消、不能再踏
  const w = mk([P('ada', 200, 100)]);
  const f = w.fighters[0];
  f.mp = 500 * FX;
  const press = { 0: S0, 10: S0, 20: S0, 30: S0 };
  const mac = commandMacro('sp_fwd_atk', 1);
  mac.forEach((b, i) => { press[44 + i] = b; });
  play(w, press, 50);
  check('連 4 段後的 16 tick 破綻中,輸入必殺指令被忽略(不能取消)', f.state === S.STEP && !f.move, 'state=' + f.state + ' move=' + f.move);
  play(w, {}, 40);
  check('破綻結束回待機', f.state === S.IDLE);
}
{
  // 步力:前衝 25、後滑 20、縱步 15;停用 0.4 s 後每秒回 30
  const w = mk([P('ada', 200, 100)]);
  const f = w.fighters[0];
  check('步力初值 100', stepPower(f) === 100);
  play(w, { 0: STEP_BYTE.fwd }, 1);
  check('前衝耗 25', stepPower(f) === 75);
  play(w, {}, 25);
  play(w, { 0: STEP_BYTE.back }, 1);
  check('後滑耗 20', stepPower(f) === 55, stepPower(f));
  play(w, {}, 40);
  play(w, { 0: STEP_BYTE.up }, 1);
  check('縱步耗 15', stepPower(f) === 40, stepPower(f));
  const p0 = stepPower(f);
  play(w, {}, 20 + 24); // 步完(20)後再等 24 tick 才開始回復
  const p1 = stepPower(f);
  play(w, {}, 60);
  const p2 = stepPower(f);
  check('停用 0.4 s(24 tick)內不回復', Math.abs(p1 - p0) < 1.1, p0 + ' → ' + p1);
  check('之後每秒回復 30', Math.abs(p2 - p1 - 30) <= 1, p1 + ' → ' + p2);
  check('步力上限 100(不會溢出)', (play(w, {}, 600), stepPower(f)) === 100);
  // 步力不夠就踏不出去
  const w2 = mk([P('ada', 200, 100)]);
  w2.fighters[0].stepP = 10 * FX;
  play(w2, { 0: STEP_BYTE.fwd }, 5);
  check('步力 10 < 前衝 25:前衝踏不出去(請求保留 6 tick 內回不到 25)', w2.fighters[0].state !== S.STEP && px(w2.fighters[0].x) === 200);
  const w3 = mk([P('ada', 200, 100)]);
  w3.fighters[0].silence = 30;
  play(w3, { 0: STEP_BYTE.fwd }, 5);
  check('封招(silence)中不能月步', w3.fighters[0].state !== S.STEP);
}
{
  // 後滑連 4 段 = 440 px / 48 tick;連 2 段後不被鎖(單段收招 8 tick 可再踏)
  const w = mk([P('ada', 900, 100)]);
  play(w, { 0: STEP_BYTE.back, 12: STEP_BYTE.back, 24: STEP_BYTE.back, 36: STEP_BYTE.back, 48: STEP_BYTE.back }, 60);
  check('後滑連 4 段 = 440 px(第 5 次超過上限)', Math.abs(px(w.fighters[0].x) - 460) <= 1, 'x=' + px(w.fighters[0].x));
  const w2 = mk([P('ada', 900, 100)]);
  play(w2, { 0: STEP_BYTE.back, 22: STEP_BYTE.back }, 50); // 單段收招 8 tick 內再踏(連踏窗含收招)
  check('收招窗內再輸入可再踏(2 段 = 220 px)', Math.abs(px(w2.fighters[0].x) - 680) <= 1, 'x=' + px(w2.fighters[0].x));
  // 縱步不可連縱步,但可接前衝
  const w3 = mk([P('ada', 200, 100)]);
  play(w3, { 0: STEP_BYTE.up, 8: STEP_BYTE.up }, 40);
  check('縱步不能連縱步(只走 60)', Math.abs(px(w3.fighters[0].z) - 40) <= 1, 'z=' + px(w3.fighters[0].z));
  const w4 = mk([P('ada', 200, 100)]);
  play(w4, { 0: STEP_BYTE.up, 8: STEP_BYTE.fwd }, 40);
  check('縱步可接前衝(z -60、x +150)', Math.abs(px(w4.fighters[0].z) - 40) <= 1 && Math.abs(px(w4.fighters[0].x) - 350) <= 1, 'x=' + px(w4.fighters[0].x) + ' z=' + px(w4.fighters[0].z));
  // 縱深操控:連踏中按住下 → 每段偏移 24 px
  const w5 = mk([P('ada', 200, 60)]);
  play(w5, { 0: S0 | BIT.DOWN, 10: S0 | BIT.DOWN }, 1);
  const w6 = mk([P('ada', 200, 60)]);
  for (let t = 0; t < 30; t++) stepWorld(w6, [(t === 0 || t === 10 ? S0 : 0) | BIT.DOWN]);
  check('連踏中按住下:每段 z 偏移 24 px(2 段 +48)、x 照常 300', Math.abs(px(w6.fighters[0].z) - 108) <= 2 && Math.abs(px(w6.fighters[0].x) - 500) <= 1, 'z=' + px(w6.fighters[0].z) + ' x=' + px(w6.fighters[0].x));
}

// ---- 3. 取消跳躍:K / A 單按 ----
{
  const w = mk([P('ada', 400, 100)]);
  let maxY = 0;
  for (let t = 0; t < 120; t++) {
    stepWorld(w, [t % 20 === 0 ? BIT.JUMP : t % 20 === 1 ? 0 : 0]);
    maxY = Math.max(maxY, w.fighters[0].y);
  }
  check('反覆單按跳:永遠不離地', maxY === 0);
  const w2 = mk([P('ada', 400, 100)]);
  stepWorld(w2, [BIT.JUMP]);
  check('K 單按 = 前衝月步', w2.fighters[0].state === S.STEP && w2.fighters[0].stepK === 1);
  const w3 = mk([P('ada', 400, 100)]);
  stepWorld(w3, [BIT.JUMP | BIT.LEFT]);
  check('K + 後 = 後滑', w3.fighters[0].state === S.STEP && w3.fighters[0].stepK === 2);
  const w4 = mk([P('ada', 400, 100)]);
  stepWorld(w4, [BIT.JUMP | BIT.UP]);
  check('K + 上 = 縱步上', w4.fighters[0].state === S.STEP && w4.fighters[0].stepK === 3);
  const w5 = mk([P('ada', 400, 100)]);
  stepWorld(w5, [BIT.JUMP | BIT.DOWN]);
  check('K + 下 = 縱步下', w5.fighters[0].state === S.STEP && w5.fighters[0].stepK === 4);
  // 防 + 前 + 跳 仍是指令(sp_fwd_jump),不是月步
  const w6 = mk([P('ada', 400, 100)]);
  w6.fighters[0].mp = 300 * FX;
  const mac = commandMacro('sp_fwd_jump', 1);
  play(w6, { 0: mac[0], 1: mac[1], 2: mac[2], 3: mac[3] }, 6);
  check('防 + 前 + 跳 = sp_fwd_jump 指令照常(不靠真跳、不觸發月步)', w6.fighters[0].move === 'sp_fwd_jump' && w6.fighters[0].y === 0, 'move=' + w6.fighters[0].move);
  // 跑中按跳 = 前衝(不再衝刺跳)
  const w7 = mk([P('ada', 400, 100)]);
  play(w7, { 0: BIT.RIGHT, 2: BIT.RIGHT }, 3);
  check('雙擊右進入跑', w7.fighters[0].state === S.RUN);
  stepWorld(w7, [BIT.RIGHT | BIT.JUMP]);
  check('跑中按跳 = 接前衝(不是衝刺跳)', w7.fighters[0].state === S.STEP && w7.fighters[0].y === 0);
  // 空中攻擊(jumpatk / dashatk)玩家無法觸發:跳不起來;招式自帶離地(launch)的空中不吃攻擊鍵
  check('跳攻 / 衝刺跳攻資料保留(RULES.noJump 關閉時可用)', !!ada.moves.jumpatk && !!ada.moves.dashatk);
}

// ---- 4. 取消進必殺 / 最強 ----
{
  const mkw = () => {
    const w = mk([P('ada', 300, 100), P('dummy', 800, 100, { kind: 'post', face: -1 })]);
    w.fighters[0].mp = 400 * FX;
    return w;
  };
  const mac = commandMacro('sp_fwd_atk', 1);
  // 前 5 tick(第 6 tick 前)不可取消:指令最後一個位元組落在 st = 3
  const early = mkw();
  play(early, { 0: S0, 1: mac[0], 2: mac[1], 3: mac[2], 4: mac[3] }, 6);
  check('月步前 6 tick 內不可取消進必殺', early.fighters[0].state === S.STEP && !early.fighters[0].move, 'state=' + early.fighters[0].state);
  const late = mkw();
  const sc = { 0: S0 };
  mac.forEach((b, i) => { sc[6 + i] = b; });
  play(late, sc, 14);
  const lf = late.fighters[0];
  check('月步第 6 tick 起可取消進必殺(MP 扣 75、進 SPECIAL)', lf.move === 'sp_fwd_atk' && lf.state === S.SPECIAL && lf.mp < 400 * FX - 70 * FX, 'move=' + lf.move + ' state=' + lf.state);
  // 連續前衝最後一段取消
  const chain = mkw();
  const sc2 = { 0: S0, 10: S0, 20: S0 };
  mac.forEach((b, i) => { sc2[26 + i] = b; });
  play(chain, sc2, 34);
  check('連踏第 3 段途中也可取消進必殺', chain.fighters[0].move === 'sp_fwd_atk');
  // 最強:fanfan 滿氣 + ULT_MACRO
  const wu = mk([P('fanfan', 300, 100), P('dummy', 800, 100, { kind: 'post', face: -1 })]);
  wu.fighters[0].rage = RAGE_MAX;
  play(wu, { 0: S0, 8: ULT_MACRO[0], 9: 0 }, 11);
  check('月步第 8 tick 輸入最強(ULT_MACRO)→ 直接發動(取消)', wu.fighters[0].ult !== 0 || wu.ult.cur === 0, 'ult=' + wu.fighters[0].ult);
  const wu2 = mk([P('fanfan', 300, 100), P('dummy', 800, 100, { kind: 'post', face: -1 })]);
  wu2.fighters[0].rage = RAGE_MAX;
  play(wu2, { 0: S0, 2: ULT_MACRO[0], 3: 0 }, 5);
  check('月步前 6 tick 不可取消進最強', wu2.fighters[0].ult === 0);
}

// ---- 5. 後滑失衡 ----
{
  const itr = { dmg: 10, fall: 20, bdef: 10, kx: 1, ky: 0, stun: 20, stop: 2, kind: 'hit', zr: 20 };
  const w = mk([P('ada', 400, 100), P('ada', 500, 100, { kind: 'post' })]);
  const a = w.fighters[0];
  takeHit(w, a, 500 * FX, itr, 1, false);
  const base = { fall: a.fall, stun: a.stunT };
  const w2 = mk([P('ada', 400, 100), P('ada', 500, 100, { kind: 'post' })]);
  play(w2, { 0: STEP_BYTE.back }, 5);
  const b = w2.fighters[0];
  const hpBefore = b.hp;
  takeHit(w2, b, 500 * FX, itr, 1, false);
  check('後滑中被打 = 失衡:fall +20、硬直 ×1.5', b.fall === base.fall + 20 && b.stunT === Math.floor(base.stun * 1.5) && b.hp < hpBefore, 'fall ' + base.fall + '→' + b.fall + ' stun ' + base.stun + '→' + b.stunT);
  const w3 = mk([P('ada', 400, 100), P('ada', 500, 100, { kind: 'post' })]);
  play(w3, { 0: STEP_BYTE.fwd }, 5);
  takeHit(w3, w3.fighters[0], 500 * FX, itr, 1, false);
  check('前衝中被打不失衡(同一般受擊)', w3.fighters[0].fall === base.fall && w3.fighters[0].stunT === base.stun);
}

// ---- 6. 暫停中(大招特寫)預先輸入月步 ----
{
  const w = mk([P('ada', 300, 100), P('ada', 900, 100, { kind: 'post', face: -1 })]);
  w.ult.cur = 1; // 假裝 1 號在放大招特寫
  w.fighters[1].ult = 1;
  w.ult.t = 0;
  for (let t = 0; t < 70; t++) stepWorld(w, [t === 10 ? STEP_BYTE.back : 0, 0]);
  check('特寫暫停中預先輸入後滑:暫停結束後立刻執行', w.ult.cur < 0 && w.fighters[0].x < 300 * FX, 'x=' + px(w.fighters[0].x) + ' cur=' + w.ult.cur);
}

// ---- 7. 普攻遞減 / 被擋 0 / 回 MP ----
{
  const poke = (w, a, d, mv = 'attack1') => {
    const def = w.defs[a.charId];
    const hf = def.moves[mv].frames.findIndex((f) => f.itr);
    d.state = S.IDLE; // 每下都讓目標回到可被打的待機(排除硬直 / 擊倒對測試的干擾)
    d.hitstop = 0;
    d.fall = 0;
    d.vy = 0;
    d.y = 0;
    a.move = mv;
    a.hm = mv;
    a.hf = hf;
    a.mseq = w.nextSeq++;
    a.x = 400 * FX;
    d.x = 430 * FX;
    a.hitstop = 0;
    const hp0 = d.hp;
    const g0 = d.gray;
    resolveHits(w);
    void g0;
    return Math.round((hp0 - d.hp) / FX); // 傷害先全額扣 hp(其中 30% 另記成灰血)
  };
  const mkw = (ch = 'ada0') => mk([P(ch, 400, 100), P('dummy', 430, 100, { kind: 'post', face: -1 })]);
  const w = mkw();
  const a = w.fighters[0];
  const d = w.fighters[1];
  a.mp = 100 * FX;
  const seq = [];
  const mps = [];
  for (let i = 0; i < 8; i++) {
    const m0 = a.mp;
    seq.push(poke(w, a, d));
    mps.push(Math.round((a.mp - m0) / FX));
  }
  const dm = 30;
  const exp = [dm, dm, dm, dm / 2, dm / 2, dm / 2, Math.round(dm / 4), Math.round(dm / 4)]; // 30 → 15 → 8(7.5 四捨五入)
  check('普攻遞減:1~3 下 ×1、4~6 下 ×0.5、第 7 下起 ×0.25', JSON.stringify(seq) === JSON.stringify(exp), seq.join(','));
  check('普攻命中回 MP:前 3 下各 +4(合計 12),第 4 下起 0', JSON.stringify(mps) === JSON.stringify([4, 4, 4, 0, 0, 0, 0, 0]), mps.join(','));
  // 3 秒內沒再被普攻打中 → 歸零
  w.tick += 181;
  check('隔 3 秒(180 tick)後計數歸零,第 1 下又是全額 + 回 MP', (() => { const m0 = a.mp; const v = poke(w, a, d); return v === dm && Math.round((a.mp - m0) / FX) === 4; })());
  // 必殺不受影響、不計入
  const w2 = mkw();
  const a2 = w2.fighters[0];
  const d2 = w2.fighters[1];
  for (let i = 0; i < 5; i++) poke(w2, a2, d2);
  const sp = poke(w2, a2, d2, 'sp_up_atk');
  check('普攻連續命中後,必殺 / 射彈以外的招式傷害照原值(必殺不遞減)', sp === (w2.defs.ada0.moves.sp_up_atk.frames.find((f) => f.itr).itr[0].dmg), 'sp_up_atk dmg=' + sp);
  check('必殺命中不計入普攻計數', d2.nHit === 5, 'nHit=' + d2.nHit);
  // 資料有 gain(例外)就照資料,不疊加全域 +4
  const w3 = mkw('ada');
  const a3 = w3.fighters[0];
  a3.mp = 100 * FX;
  const m3 = a3.mp;
  poke(w3, a3, w3.fighters[1]);
  check('普攻 itr.gain > 0(帆帆例外)照資料 +5,不疊加全域 +4', Math.round((a3.mp - m3) / FX) === 5, (a3.mp - m3) / FX);
  // 被擋 0 傷害、bdef 累積、不計數、不回 MP
  const w4 = mkw();
  const a4 = w4.fighters[0];
  const d4 = w4.fighters[1];
  a4.mp = 100 * FX;
  d4.state = S.DEFEND;
  d4.face = -1;
  d4.kind = 'post';
  const hp0 = d4.hp;
  const def4 = w4.defs.ada0;
  const hf = def4.moves.attack1.frames.findIndex((f) => f.itr);
  a4.move = 'attack1'; a4.hm = 'attack1'; a4.hf = hf; a4.mseq = w4.nextSeq++;
  resolveHits(w4);
  check('普攻被正面防住:0 傷害、累積 bdef、不計入遞減、不回 MP', d4.hp === hp0 && d4.bdef > 0 && d4.nHit === 0 && a4.mp === 100 * FX, 'hp=' + (d4.hp - hp0) + ' bdef=' + d4.bdef + ' nHit=' + d4.nHit);
  // 對照:非普攻(sp)被擋仍吃 10%
  const w5 = mkw();
  const a5 = w5.fighters[0];
  const d5 = w5.fighters[1];
  d5.state = S.DEFEND; d5.face = -1; d5.kind = 'post';
  const h5 = d5.hp;
  const hf5 = w5.defs.ada0.moves.sp_up_atk.frames.findIndex((f) => f.itr);
  a5.move = 'sp_up_atk'; a5.hm = 'sp_up_atk'; a5.hf = hf5; a5.mseq = w5.nextSeq++;
  resolveHits(w5);
  check('必殺被擋仍吃 10% 擦傷(只有普攻 0)', d5.hp < h5);
  // 被打回 MP +5
  const w6 = mkw();
  const d6 = w6.fighters[1];
  d6.mp = 0;
  takeHit(w6, d6, 400 * FX, { dmg: 5, fall: 0, bdef: 0, kx: 0, ky: 0, stun: 5, stop: 0, kind: 'hit', zr: 20 }, 0, false);
  check('被打回 MP +5(原 3)', d6.mp === 5 * FX, d6.mp / FX);
}

// ---- 8. codec 新欄位 ----
{
  const ctx = makeCtx(chars);
  const w = mk([P('ada', 300, 100), P('ada0', 700, 100, { kind: 'post', face: -1 })]);
  play(w, { 0: STEP_BYTE.fwd, 10: S0 }, 15);
  const f = w.fighters[0];
  f.nHit = 3;
  f.nHitT = 77;
  const snap = serializeWorld(w);
  const dec = decodeWorld(encodeWorld(snap, ctx), ctx);
  const KEYS = ['stepP', 'stepK', 'stepN', 'stepRt', 'stepLk', 'sreq', 'sreqT', 'nHit', 'nHitT'];
  check('codec:全狀態往返保留月步 / 遞減欄位', KEYS.every((k) => dec.fighters[0][k] === snap.fighters[0][k]) && dec.fighters[0].stepN === 2, KEYS.map((k) => k + '=' + dec.fighters[0][k]).join(' '));
  // 差量
  w.tick; play(w, {}, 3);
  const snap2 = serializeWorld(w);
  const dd = applyDelta(dec, encodeDelta(snap, snap2, ctx), ctx);
  const full2 = decodeWorld(encodeWorld(snap2, ctx), ctx);
  check('codec:差量快照套用後與完整快照逐欄位一致(含新欄位)', JSON.stringify(dd.fighters[0]) === JSON.stringify(full2.fighters[0]));
  // 舊快照(沒有新欄位)也能編碼與還原補預設
  const old = serializeWorld(mk([P('ada', 300, 100), P('ada0', 700, 100, { kind: 'post', face: -1 })]));
  for (const fi of old.fighters) for (const k of KEYS) delete fi[k];
  let okOld = true;
  try {
    const d2 = decodeWorld(encodeWorld(old, ctx), ctx);
    okOld = d2.fighters[0].stepP === 100 * FX && d2.fighters[0].nHit === 0 && d2.fighters[0].sreqT === -999;
    const w2 = mk([P('ada', 300, 100), P('ada0', 700, 100, { kind: 'post', face: -1 })]);
    restoreWorld(w2, old);
    okOld = okOld && w2.fighters[0].stepP === 100 * FX && w2.fighters[0].stepRt === 24 && w2.fighters[0].sreq === 0;
    play(w2, {}, 30);
  } catch (e) {
    okOld = false;
    console.log(e);
  }
  check('舊快照(缺新欄位)可編碼、還原補預設、續跑不報錯', okOld);
}

// ---- 9. 決定性:隨機輸入(含 STEP 位元)3 分鐘 + 還原 ----
{
  const scenario = (seed) => {
    const w = mk([P('ada', 300, 100), P('ada0', 700, 120, { face: -1 }), P('ada', 500, 60, { kind: 'post' })], seed);
    const r = new Rng(seed);
    const inputs = [];
    let cur = [0, 0];
    for (let t = 0; t < 10800; t++) {
      if (t % 9 === 0) cur = [r.next() & 255, r.next() & 255];
      inputs.push(cur);
    }
    return { w, inputs };
  };
  const run = (s, from, to) => {
    const hs = [];
    let stepTicks = 0;
    for (let t = from; t < to; t++) {
      stepWorld(s.w, [s.inputs[t][0], s.inputs[t][1], 0]);
      for (const f of s.w.fighters) if (f.state === S.STEP) stepTicks++;
      if (t % 60 === 59) hs.push(hashWorld(s.w));
    }
    return { hs, stepTicks };
  };
  const a = run(scenario(11), 0, 10800);
  const b = run(scenario(11), 0, 10800);
  check('隨機輸入(含月步位元)3 分鐘:同種子每秒雜湊一致,且確實踩了月步', JSON.stringify(a.hs) === JSON.stringify(b.hs) && a.stepTicks > 500, 'stepTicks=' + a.stepTicks);
  const c = scenario(11);
  run(c, 0, 5000);
  const snap = serializeWorld(c.w);
  const d = scenario(11);
  restoreWorld(d.w, snap);
  const hc = run(c, 5000, 10800).hs;
  const hd = run(d, 5000, 10800).hs;
  check('序列化 → 還原後繼續跑一致(含月步狀態 / 請求緩衝)', JSON.stringify(hc) === JSON.stringify(hd));
  // 以 codec 往返當還原來源
  const ctx = makeCtx(chars);
  const e = scenario(11);
  run(e, 0, 5000);
  const via = decodeWorld(encodeWorld(serializeWorld(e.w), ctx), ctx);
  const g = scenario(11);
  restoreWorld(g.w, via);
  // codec 還原的物件鍵順序與原本不同,雜湊(JSON 字串)不能直接比;改比「鍵排序後」的狀態
  const canon = (w) => JSON.stringify(serializeWorld(w), (k, v) => (v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map((x) => [x, v[x]])) : v));
  const ref = scenario(11);
  run(ref, 0, 5000);
  let same = true;
  for (let t = 5000; t < 10800 && same; t++) {
    const i = [ref.inputs[t][0], ref.inputs[t][1], 0];
    stepWorld(ref.w, i);
    stepWorld(g.w, i);
    if (t % 30 === 0 && canon(ref.w) !== canon(g.w)) same = false;
  }
  check('經 codec 編解碼還原後續跑與原世界逐 30 tick 狀態一致(連線同步)', same);
}

// ---- 10. AI:月步與必殺 ----
{
  // 追擊:遠距離面對面的 AI 會用前衝
  let sawStep = 0;
  let steps = 0;
  const w = mk([P('ada', 200, 100, { kind: 'ai', lvl: 3 }), P('dummy', 1300, 100, { kind: 'post', face: -1 })]);
  for (let t = 0; t < 900; t++) {
    stepWorld(w, [0, 0]);
    if (w.fighters[0].state === S.STEP) steps++;
    if (w.fighters[0].state === S.STEP && w.fighters[0].stepK === 1) sawStep = 1;
  }
  check('AI(魔王)遠距離會用前衝月步追擊', sawStep === 1 && steps > 20, 'stepTicks=' + steps);
  const w0 = mk([P('ada', 200, 100, { kind: 'ai', lvl: 0 }), P('dummy', 1300, 100, { kind: 'post', face: -1 })]);
  let s0 = 0;
  for (let t = 0; t < 900; t++) {
    stepWorld(w0, [0, 0]);
    if (w0.fighters[0].state === S.STEP) s0++;
  }
  check('AI(新手)chase = 0:不追擊月步', s0 === 0, 's0=' + s0);
  // 8 人電腦混戰(真實 12 角色資料,含大地震新判定):數千 tick 無錯誤、必殺用得多、月步有用到
  const allChars = Object.assign({}, real, { ada, dummy });
  const list = ['fanfan', 'areh', 'guanyu', 'lubu', 'magnet', 'sun', 'piggy', 'manman'];
  const spawns = list.map((c, i) => ({ charId: c, kind: 'ai', lvl: 1 + (i % 3), x: 200 + i * 170, z: 40 + (i % 4) * 55, face: i % 2 ? -1 : 1, team: i }));
  const run8 = () => {
    const w8 = createWorld({ chars: allChars, seed: 21, ult: true, stage: { w: 1600, d: 240 }, spawns, mode: 'brawl' });
    let st = 0;
    let sp = 0;
    let ults = 0;
    const prevMove = w8.fighters.map(() => null);
    for (let t = 0; t < 6000; t++) {
      stepWorld(w8, new Array(8).fill(0));
      w8.fighters.forEach((f, i) => {
        if (f.state === S.STEP) st++;
        if (f.move !== prevMove[i]) {
          if (f.move && f.move.startsWith('sp_')) sp++;
          if (f.move === 'ultimate') ults++;
        }
        prevMove[i] = f.move;
      });
    }
    return { st, sp, ults, h: hashWorld(w8), over: w8.mode.over };
  };
  let r1;
  let err = null;
  try {
    r1 = run8();
  } catch (e) {
    err = e;
    console.log(e);
  }
  check('8 人電腦混戰 6000 tick 無錯誤、月步有用到、必殺有放', !err && r1.st > 100 && r1.sp >= 8, err ? String(err) : 'stepTicks=' + r1.st + ' specials=' + r1.sp + ' ults=' + r1.ults + ' over=' + r1.over);
  check('8 人混戰可重現(兩次雜湊相同)', !err && run8().h === r1.h);
}

// ---- 11. 規格表自洽 ----
{
  const f = STEP_SPEC[1];
  const b = STEP_SPEC[2];
  const u = STEP_SPEC[3];
  check('STEP_SPEC:前衝 150 px / 後滑 110 px / 縱步 60 px', Math.round((f.dx * f.mv)) === 150 && Math.round(b.dx * b.mv) === -110 && Math.abs(u.dz * u.mv) === 60);
  check('stepMacro 輸出與 BIT.STEP 編碼一致', stepMacro('fwd', 1)[0] === S0 && stepMacro('back', 1)[0] === (S0 | BIT.LEFT | BIT.RIGHT));
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
