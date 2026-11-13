import { drawCutinArt } from './sprites.js';

const FONT = '"Microsoft JhengHei", "PingFang TC", sans-serif';
const SHOW = 60;

// 大招演出(只讀 w.ult;連線視圖沒有 w.ult 時不畫):
// 完整特寫 = 暗幕 60% + 色帶 + 角色特寫從左側切入 + 招名大字;冷卻中的輕演出 = 淡暗幕 20 tick + 小字招名
export function drawUltOverlay(ctx, w) {
  const U = w.ult;
  if (!U) return;
  if (U.cur >= 0) {
    const f = w.fighters[U.cur];
    if (!f) return;
    const def = w.defs[f.charId];
    const t = U.t;
    const fade = Math.min(1, t / 6, (SHOW - t) / 8);
    ctx.fillStyle = 'rgba(0,0,0,' + (0.6 * Math.max(0, fade)).toFixed(3) + ')';
    ctx.fillRect(0, 0, 800, 450);
    const slide = Math.min(1, t / 10);
    const out = Math.max(0, (t - (SHOW - 8)) / 8);
    const ease = 1 - Math.pow(1 - slide, 3);
    const dx = -520 * (1 - ease) - 520 * out;
    ctx.fillStyle = def.color;
    ctx.globalAlpha = 0.85 * Math.max(0, fade);
    ctx.fillRect(0, 150, 800, 150);
    ctx.globalAlpha = 1;
    drawCutinArt(ctx, f.charId, 230 + dx, 330, 2.8, false);
    const name = (def.moves.ultimate && def.moves.ultimate.ult && def.moves.ultimate.ult.name) || def.name;
    ctx.save();
    ctx.translate(430 - dx * 0.6, 235);
    ctx.transform(1, 0, -0.18, 1, 0, 0);
    ctx.font = 'bold 44px ' + FONT;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.lineWidth = 6;
    ctx.strokeStyle = 'rgba(0,0,0,0.7)';
    ctx.strokeText(name, 0, 0);
    ctx.fillStyle = '#fff';
    ctx.fillText(name, 0, 0);
    ctx.restore();
    ctx.textAlign = 'left';
    ctx.textBaseline = 'top';
  } else if (U.dim > 0) {
    ctx.fillStyle = 'rgba(0,0,0,' + (0.4 * (U.dim / 20)).toFixed(3) + ')';
    ctx.fillRect(0, 0, 800, 450);
    const f = w.fighters[U.dimId];
    const def = f && w.defs[f.charId];
    const info = def && def.moves.ultimate && def.moves.ultimate.ult;
    if (info) {
      ctx.globalAlpha = U.dim / 20;
      ctx.font = 'bold 22px ' + FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = '#fff';
      ctx.fillText(info.name, 400, 110);
      ctx.globalAlpha = 1;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
    }
  }
}
