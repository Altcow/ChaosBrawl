import { BIT, STEP_BYTE } from '../core/input.js';

// 指令判讀:防 + 方向(前/上/下) + 攻/跳,三個輸入在 15 tick 內完成,依序或同時皆可
// hist:最近的輸入位元組(最新在最後),含本 tick。trig:本 tick 剛按下的 BIT.ATK 或 BIT.JUMP
export const CMD_WINDOW = 15;

export function detectCommand(hist, trig, face) {
  const n = hist.length;
  const from = Math.max(0, n - 1 - CMD_WINDOW);
  const fwd = face > 0 ? BIT.RIGHT : BIT.LEFT;
  let hasDef = false;
  for (let i = from; i < n; i++) if (hist[i] & BIT.DEF) hasDef = true;
  if (!hasDef) return null;

  // 視窗內「最近一次按下」的方向;沒有按下事件就取目前按著的方向
  let dir = null;
  for (let i = n - 1; i >= from && dir === null; i--) {
    const cur = hist[i];
    const prev = i > 0 ? hist[i - 1] : 0;
    const edge = cur & ~prev;
    if (edge & BIT.UP) dir = 'up';
    else if (edge & BIT.DOWN) dir = 'down';
    else if (edge & fwd) dir = 'fwd';
  }
  if (dir === null) {
    const cur = hist[n - 1];
    if (cur & BIT.UP) dir = 'up';
    else if (cur & BIT.DOWN) dir = 'down';
    else if (cur & fwd) dir = 'fwd';
  }
  if (dir === null) return null;
  return 'sp_' + dir + '_' + (trig === BIT.ATK ? 'atk' : 'jump');
}

// 大招輸入序列:防 + 攻 + 跳 同時按(AI 與觸控大招鈕共用,見 ult.js ULT_MACRO)
export { ULT_MACRO } from './ult.js';

// 把指令名(例 sp_fwd_atk)轉成逐 tick 的輸入序列:AI 與觸控「必殺輔助鍵」共用
export function commandMacro(cmd, face) {
  const p = cmd.split('_');
  const d = p[1] === 'fwd' ? (face > 0 ? BIT.RIGHT : BIT.LEFT) : p[1] === 'up' ? BIT.UP : BIT.DOWN;
  const trig = p[2] === 'atk' ? BIT.ATK : BIT.JUMP;
  return [BIT.DEF | d, BIT.DEF | d, BIT.DEF | d | trig, 0];
}

// ---- 月步(取消跳躍後的位移):種類 1 前衝 / 2 後滑 / 3 縱步上 / 4 縱步下 ----
export const STEP_FWD = 1;
export const STEP_BACK = 2;
export const STEP_UP = 3;
export const STEP_DOWN = 4;
export const STEP_KIND = { fwd: STEP_FWD, back: STEP_BACK, up: STEP_UP, down: STEP_DOWN };

// 含 BIT.STEP 的輸入位元組 → 種類(編碼見 input.js STEP_BYTE;單向 / 單一左右只是搖桿的操控,不改種類)
export function stepKindOf(b) {
  const u = (b & BIT.UP) && (b & BIT.DOWN);
  const l = (b & BIT.LEFT) && (b & BIT.RIGHT);
  return u && l ? STEP_DOWN : u ? STEP_UP : l ? STEP_BACK : STEP_FWD;
}

// 鍵盤 K / 手把 A(JUMP 位元單按、前後 15 tick 沒有防)→ 種類:上 / 下 = 縱步、反方向 = 後滑、其餘前衝
export function jumpStepKind(b, face) {
  if (b & BIT.UP) return STEP_UP;
  if (b & BIT.DOWN) return STEP_DOWN;
  if (b & (face > 0 ? BIT.LEFT : BIT.RIGHT)) return STEP_BACK;
  return STEP_FWD;
}

// 月步輸入序列(AI 共用;input.queueStep 同編碼)。face 不需要,保留參數與 commandMacro 對稱
export function stepMacro(kind, face) {
  const b = STEP_BYTE[kind];
  return [b, 0];
}
