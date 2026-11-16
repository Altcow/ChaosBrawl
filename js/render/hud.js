import { STATE_NAMES, S } from '../sim/fighter.js';

const S_LYING = S.LYING;
const S_FALL = S.FALL;

const FONT = '"Microsoft JhengHei", "PingFang TC", sans-serif';
export const SLOT_COLORS = ['#ff5555', '#55a0ff', '#55dd77', '#ffcc33', '#d070ff', '#ff9040', '#40e0d0', '#f080b0'];

function bar(ctx, x, y, w, h, frac, color, back) {
  ctx.fillStyle = back || 'rgba(0,0,0,0.55)';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = color;
  ctx.fillRect(x, y, Math.max(0, Math.min(1, frac)) * w, h);
}

// 本機玩家(大招提示用):主程式每幀設定 ids = 本機真人角色 id、touch = 是否顯示觸控鈕
let hint = { ids: [], touch: false };
export function setHudHint(ids, touch) {
  hint = { ids, touch: !!touch };
}

// 爆氣條(0~100 定點數 ×256):金色;滿了閃爍;條旁標示「大招」
function rageBar(ctx, x, y, w, h, rage, fs, ly) {
  const full = rage >= 100 * 256;
  const flash = full && (Date.now() >> 7) & 1;
  bar(ctx, x, y, w, h, rage / (100 * 256), flash ? '#fff6b0' : '#ffc400');
  ctx.fillStyle = full ? (flash ? '#fff6b0' : '#ffc400') : '#c8b060';
  ctx.font = (full ? 'bold ' : '') + fs + 'px ' + FONT;
  ctx.fillText('大招', x + w + 3, ly);
}

// 爆氣滿了:畫面上方閃爍提示(只給本機玩家)
function drawUltHint(ctx, w) {
  if (w.mode.over || (w.ult && w.ult.on === false)) return;
  let ready = false;
  for (const id of hint.ids) {
    const f = w.fighters[id];
    if (f && !f.dead && !f.ult && f.rage >= 100 * 256 && w.defs[f.charId].hasUlt) ready = true;
  }
  if (!ready) return;
  const msg = hint.touch ? '大招可用!點右側「大招」鈕 ▶' : '大招可用!按 防+攻+跳(鍵盤 U / 手把 Y)';
  ctx.font = 'bold 15px ' + FONT;
  const tw = ctx.measureText(msg).width + 24;
  ctx.globalAlpha = (Date.now() >> 8) & 1 ? 1 : 0.55;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(400 - tw / 2, 60, tw, 24);
  ctx.fillStyle = '#ffd84a';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(msg, 400, 72);
  ctx.globalAlpha = 1;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
}

// 練習模式:單角色詳細面板
function drawPracticeHud(ctx, w, stats, debug) {
  const f = w.fighters[0];
  const def = w.defs[f.charId];
  const hp = f.hp / def.hp;
  const gray = (f.hp + f.gray) / def.hp;
  ctx.font = '12px ' + FONT;
  ctx.textBaseline = 'top';
  ctx.fillStyle = '#fff';
  ctx.fillText(def.name, 12, 8);
  ctx.fillStyle = 'rgba(0,0,0,0.55)';
  ctx.fillRect(12, 24, 200, 14);
  ctx.fillStyle = '#888';
  ctx.fillRect(12, 24, Math.min(1, gray) * 200, 14);
  ctx.fillStyle = '#e44';
  ctx.fillRect(12, 24, Math.min(1, hp) * 200, 14);
  ctx.fillStyle = '#fff';
  ctx.fillText(Math.ceil(f.hp / 256) + ' / ' + (def.hp >> 8), 16, 25);
  bar(ctx, 12, 42, 200, 8, f.mp / def.mp, '#48f');
  if (def.hasUlt) rageBar(ctx, 12, 74, 200, 6, f.rage || 0, 10, 71);
  bar(ctx, 12, 54, 200, 5, f.fall / 100, '#f90');
  bar(ctx, 12, 62, 200, 5, f.bdef / 100, '#6cf');
  ctx.fillStyle = '#ccc';
  ctx.font = '10px ' + FONT;
  ctx.fillText('MP ' + Math.floor(f.mp / 256) + '   fall ' + f.fall + '   bdef ' + f.bdef, 12, 84);
  ctx.font = '12px ' + FONT;
  ctx.fillText(STATE_NAMES[f.state] + (f.move ? ' · ' + f.move : ''), 12, 100);
  if (debug) {
    ctx.fillStyle = '#9f9';
    ctx.fillText('tick ' + w.tick + '  fps ' + stats.fps + '  tps ' + stats.tps, 12, 116);
  }
}

// 多人:上方 2 排 × 4 的小型條(不遮戰場),只顯示隊色圈、不顯示名字
function drawGridHud(ctx, w, stats, debug) {
  ctx.textBaseline = 'top';
  ctx.font = '10px ' + FONT;
  for (let i = 0; i < w.fighters.length; i++) {
    const f = w.fighters[i];
    const def = w.defs[f.charId];
    const x = 8 + (i % 4) * 148;
    const y = 6 + (i >> 2) * 26;
    ctx.globalAlpha = f.dead ? 0.35 : 1;
    ctx.fillStyle = SLOT_COLORS[f.team % 8];
    ctx.beginPath();
    ctx.arc(x + 6, y + 8, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#000';
    ctx.font = 'bold 9px ' + FONT;
    ctx.fillText(String(i + 1), x + 3.5, y + 4);
    const gray = (f.hp + f.gray) / def.hp;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(x + 16, y + 2, 100, 8);
    ctx.fillStyle = '#888';
    ctx.fillRect(x + 16, y + 2, Math.min(1, gray) * 100, 8);
    ctx.fillStyle = '#e44';
    ctx.fillRect(x + 16, y + 2, Math.min(1, f.hp / def.hp) * 100, 8);
    bar(ctx, x + 16, y + 12, 100, 3, f.mp / def.mp, '#48f');
    if (def.hasUlt) rageBar(ctx, x + 16, y + 16, 100, 3, f.rage || 0, 8, y + 14);
    if (w.mode.type === 'timed') {
      ctx.fillStyle = '#fff';
      ctx.font = '10px ' + FONT;
      ctx.fillText(String(f.kills), x + 120, y + 1);
    }
    ctx.globalAlpha = 1;
  }
  if (debug) {
    ctx.fillStyle = '#9f9';
    ctx.font = '12px ' + FONT;
    ctx.fillText('tick ' + w.tick + '  fps ' + stats.fps + '  tps ' + stats.tps, 8, 64);
  }
}

export function drawHud(ctx, w, stats, debug) {
  if (w.mode.type === 'practice') drawPracticeHud(ctx, w, stats, debug);
  else {
    drawGridHud(ctx, w, stats, debug);
    // 計時
    const left = Math.max(0, w.mode.limit - w.mode.t);
    const sec = Math.ceil(left / 60);
    ctx.fillStyle = '#fff';
    ctx.font = 'bold 20px ' + FONT;
    ctx.textAlign = 'center';
    ctx.fillText(Math.floor(sec / 60) + ':' + String(sec % 60).padStart(2, '0') + (w.mode.overtime ? ' 加賽' : ''), 722, 44);
    ctx.textAlign = 'left';
  }
  drawUltHint(ctx, w);
}

export function drawResult(ctx, w, nameOf) {
  if (!w.mode.over) return;
  ctx.fillStyle = 'rgba(0,0,0,0.6)';
  ctx.fillRect(0, 150, 800, 120);
  ctx.fillStyle = '#fff';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = 'bold 30px ' + FONT;
  ctx.fillText(w.mode.winner < 0 ? '平手' : w.mode.type === 'team' ? '隊伍 ' + (w.mode.winner + 1) + ' 獲勝' : '勝者:' + nameOf(w.mode.winner), 400, 195);
  ctx.font = '14px ' + FONT;
  ctx.fillStyle = '#ccc';
  ctx.fillText('按「選單」或 Enter 回到選單', 400, 240);
  ctx.textAlign = 'left';
  ctx.textBaseline = 'top';
}

// 假人 / 電腦頭上小血條
export function drawOverhead(ctx, w, f, sx, sy) {
  const def = w.defs[f.charId];
  bar(ctx, sx - 22, sy - 78, 44, 5, f.hp / def.hp, '#e44');
  if (w.mode.type === 'practice') {
    bar(ctx, sx - 22, sy - 72, 44, 3, f.fall / 100, '#f90');
    bar(ctx, sx - 22, sy - 68, 44, 3, f.bdef / 100, '#6cf');
  }
}

// 頭上名字:畫在血條上方(by = 血條頂的畫面 y),白字黑描邊;本機玩家黃字加 ▼;太長截斷
export function drawName(ctx, f, sx, by, label, isMe) {
  if (!label) return;
  let t = String(label);
  if (t.length > 6) t = t.slice(0, 5) + '…';
  ctx.save();
  ctx.globalAlpha = f.state === S_LYING || f.state === S_FALL ? 0.45 : 1;
  ctx.font = 'bold 9px ' + FONT;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'bottom';
  ctx.lineJoin = 'round';
  ctx.lineWidth = 3;
  ctx.strokeStyle = '#000';
  ctx.strokeText(t, sx, by - 2);
  ctx.fillStyle = isMe ? '#ffe566' : '#fff';
  ctx.fillText(t, sx, by - 2);
  if (isMe) {
    ctx.fillStyle = '#ffe566';
    ctx.beginPath();
    ctx.moveTo(sx - 3, by - 14);
    ctx.lineTo(sx + 3, by - 14);
    ctx.lineTo(sx, by - 10);
    ctx.fill();
  }
  ctx.restore();
}

export function isLocalFighter(i) {
  return hint.ids.indexOf(i) >= 0;
}
