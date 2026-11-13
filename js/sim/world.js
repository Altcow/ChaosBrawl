import { Rng } from '../core/rng.js';
import { compileChar, createFighter, updateFighter, bufferInput, stepHolds } from './fighter.js';
import { newUlt, normalizeFighter, startQueued, endShow, ULT_SHOW } from './ult.js';
import { stepProjectiles } from './projectiles.js';
import { resolveHits } from './hit.js';
import { think } from './ai.js';
import { initMode, stepMode } from './modes.js';

// 模擬層:不碰 DOM、不碰繪圖。全狀態皆為整數 / 純物件,可序列化。
// ult:房間設定「大招」,預設關(連線快照編碼還沒帶大招狀態,見回報);單機由 main.js 傳 true
export function createWorld({ chars, seed, stage, spawns, mode, ff, ult }) {
  const w = {
    tick: 0, rng: new Rng(seed), nextSeq: 1,
    stage: stage || { w: 1600, d: 240 },
    defs: {}, fighters: [], projectiles: [], events: [], mode: null, ult: newUlt(!!ult)
  };
  initMode(w, mode || 'practice', ff || 0);
  for (const id in chars) w.defs[id] = compileChar(chars[id]);
  spawns.forEach((s, i) => w.fighters.push(createFighter(w, s, i)));
  return w;
}

// inputs[i] = 第 i 個角色的輸入位元組(僅 kind === 'human' 使用)
export function stepWorld(w, inputs) {
  w.events = [];
  const U = w.ult;
  const paused = U.cur >= 0; // 大招特寫:全場世界暫停(tick 照走,模式計時與角色 / 射彈都不動)
  for (const f of w.fighters) {
    const inb = f.kind === 'human' ? inputs[f.id] || 0 : think(w, f);
    if (paused) bufferInput(f, w, inb);
    else updateFighter(f, w, inb);
  }
  if (paused) {
    U.t++;
    if (U.t >= ULT_SHOW) endShow(w);
    w.tick++;
    return;
  }
  stepProjectiles(w);
  resolveHits(w);
  stepHolds(w);
  stepMode(w);
  for (const f of w.fighters) if (f.ultGuard > 0) f.ultGuard--;
  if (U.cd > 0) U.cd--;
  if (U.dim > 0) U.dim--;
  startQueued(w);
  w.tick++;
}

export function serializeWorld(w) {
  return JSON.parse(JSON.stringify({
    tick: w.tick, rng: w.rng.getState(), nextSeq: w.nextSeq, mode: w.mode,
    fighters: w.fighters, projectiles: w.projectiles, ult: w.ult
  }));
}

export function restoreWorld(w, snap) {
  const s = JSON.parse(JSON.stringify(snap));
  w.tick = s.tick;
  w.rng.setState(s.rng);
  w.nextSeq = s.nextSeq;
  w.mode = s.mode;
  w.fighters = s.fighters;
  w.projectiles = s.projectiles;
  for (const f of w.fighters) normalizeFighter(f);
  // 連線解碼出的快照不含大招狀態時,沿用目前房間設定、其餘歸預設
  w.ult = s.ult || newUlt(w.ult ? w.ult.on : true);
  w.events = [];
}

// FNV-1a,供決定性測試比對
export function hashWorld(w) {
  const str = JSON.stringify(serializeWorld(w));
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h >>> 0;
}
