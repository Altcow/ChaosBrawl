import { Rng } from '../core/rng.js';
import { compileChar, createFighter, updateFighter } from './fighter.js';
import { stepProjectiles } from './projectiles.js';
import { resolveHits } from './hit.js';
import { think } from './ai.js';
import { initMode, stepMode } from './modes.js';

// 模擬層:不碰 DOM、不碰繪圖。全狀態皆為整數 / 純物件,可序列化。
export function createWorld({ chars, seed, stage, spawns, mode, ff }) {
  const w = {
    tick: 0, rng: new Rng(seed), nextSeq: 1,
    stage: stage || { w: 1600, d: 240 },
    defs: {}, fighters: [], projectiles: [], events: [], mode: null
  };
  initMode(w, mode || 'practice', ff || 0);
  for (const id in chars) w.defs[id] = compileChar(chars[id]);
  spawns.forEach((s, i) => w.fighters.push(createFighter(w, s, i)));
  return w;
}

// inputs[i] = 第 i 個角色的輸入位元組(僅 kind === 'human' 使用)
export function stepWorld(w, inputs) {
  w.events = [];
  for (const f of w.fighters) {
    const inb = f.kind === 'human' ? inputs[f.id] || 0 : think(w, f);
    updateFighter(f, w, inb);
  }
  stepProjectiles(w);
  resolveHits(w);
  stepMode(w);
  w.tick++;
}

export function serializeWorld(w) {
  return JSON.parse(JSON.stringify({
    tick: w.tick, rng: w.rng.getState(), nextSeq: w.nextSeq, mode: w.mode,
    fighters: w.fighters, projectiles: w.projectiles
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
