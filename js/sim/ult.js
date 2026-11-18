import { BIT } from '../core/input.js';
import { FX } from '../core/fixed.js';

// 大招系統(角色名單設計 第 2 節):爆氣條 0~100(定點數,與 hp / mp 同為 ×FX)、演出排隊、全場冷卻、傷害上限與保護
export const RAGE_MAX = 100 * FX;
export const ULT_SHOW = 60; // 全場暫停 + 特寫(1 s)
export const ULT_CD = 180; // 全場演出冷卻(3 s,從特寫結束起算)
export const ULT_DIM = 20; // 冷卻中發動:只暗幕 20 tick、不暫停
export const ULT_GUARD = 180; // 被大招打中後 3 s 內不再吃其他大招傷害
export const ULT_CAP = { dodge: 180, area: 100, control: 40 }; // 每目標傷害上限(依類型)
export const ULT_MACRO = [BIT.DEF | BIT.ATK | BIT.JUMP, 0]; // AI / 觸控大招鈕共用的輸入序列

// w.ult:cur = 正在播特寫的角色 id(-1 = 無)、t = 已播 tick、q = 排隊中的角色 id、cd = 全場冷卻、
// dim = 輕演出(暗幕)剩餘 tick、dimId = 輕演出的發動者、on = 房間設定(預設開)
export function newUlt(on) {
  return { on: on !== false, cur: -1, t: 0, q: [], cd: 0, dim: 0, dimId: -1 };
}

// 舊快照 / 連線解碼出來的角色沒有大招欄位時補預設
export function normalizeFighter(f) {
  if (f.rage === undefined) f.rage = 0;
  if (f.ult === undefined) f.ult = 0;
  if (f.ultSeq === undefined) f.ultSeq = 0;
  if (f.ultDmg === undefined) f.ultDmg = {};
  if (f.ultGuard === undefined) f.ultGuard = 0;
  if (f.ultGuardBy === undefined) f.ultGuardBy = 0;
  if (f.held === undefined) f.held = -1;
  if (f.ctlT === undefined) f.ctlT = 0;
  if (f.mkx === undefined) f.mkx = 0;
  if (f.mkz === undefined) f.mkz = 0;
  if (f.buf === undefined) f.buf = '';
  if (f.bufT === undefined) f.bufT = 0;
  if (f.aftT === undefined) f.aftT = 0;
  // 月步 / 普攻遞減欄位(舊快照沒有時補預設:步力滿、無請求、遞減計數 0)
  if (f.stepP === undefined) f.stepP = 100 * FX;
  if (f.stepK === undefined) f.stepK = 0;
  if (f.stepN === undefined) f.stepN = 0;
  if (f.stepRt === undefined) f.stepRt = 24;
  if (f.stepLk === undefined) f.stepLk = 0;
  if (f.sreq === undefined) f.sreq = 0;
  if (f.sreqT === undefined) f.sreqT = -999;
  if (f.nHit === undefined) f.nHit = 0;
  if (f.nHitT === undefined) f.nHitT = -999;
}

export function ultCap(info) {
  const typeCap = ULT_CAP[info.type] !== undefined ? ULT_CAP[info.type] : ULT_CAP.dodge;
  return info.cap !== undefined ? Math.min(info.cap, typeCap) : typeCap;
}

// 依序處理排隊:沒有演出且不在冷卻 → 第一名播完整特寫;其餘(冷卻中)只暗幕、立刻動作
export function startQueued(w) {
  const U = w.ult;
  while (U.q.length) {
    const id = U.q.shift();
    const f = w.fighters[id];
    if (!f || f.ult !== 1) continue;
    if (U.cur < 0 && U.cd <= 0) {
      U.cur = id;
      U.t = 0;
      w.events.push({ t: 'ult', x: f.x, y: f.y, z: f.z, id, full: true });
      return;
    }
    f.ult = 2;
    U.dim = ULT_DIM;
    U.dimId = id;
    w.events.push({ t: 'ult', x: f.x, y: f.y, z: f.z, id, full: false });
  }
}

export function endShow(w) {
  const U = w.ult;
  const f = w.fighters[U.cur];
  if (f && f.ult === 1) f.ult = 2;
  U.cur = -1;
  U.t = 0;
  U.cd = ULT_CD;
  startQueued(w);
}
