import { BIT } from '../core/input.js';

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

// 把指令名(例 sp_fwd_atk)轉成逐 tick 的輸入序列:AI 與觸控「必殺輔助鍵」共用
export function commandMacro(cmd, face) {
  const p = cmd.split('_');
  const d = p[1] === 'fwd' ? (face > 0 ? BIT.RIGHT : BIT.LEFT) : p[1] === 'up' ? BIT.UP : BIT.DOWN;
  const trig = p[2] === 'atk' ? BIT.ATK : BIT.JUMP;
  return [BIT.DEF | d, BIT.DEF | d, BIT.DEF | d | trig, 0];
}
