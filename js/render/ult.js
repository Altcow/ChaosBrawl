import { drawCutinArt, cutinSize } from './sprites.js';

const FONT = '"Microsoft JhengHei", "PingFang TC", sans-serif';
const SHOW = 60;

// 特寫進出淡入淡出係數 0~1(特寫期間 HUD 依此壓低,避免與特寫重疊)
export function ultCutinFade(w) {
  const U = w.ult;
  if (!U || U.cur < 0 || !w.fighters[U.cur]) return 0;
  return Math.max(0, Math.min(1, U.t / 6, (SHOW - U.t) / 8));
}

// 呼呼大招「一覺到天亮」畫面變夜:純渲染,依 w 狀態推目標、逐幀平滑淡入淡出;找不到呼呼大招時目標為 0
let nightK = 0;
function nightTarget(w) {
  const U = w.ult;
  if (!U) return 0;
  for (let i = 0; i < w.fighters.length; i++) {
    const f = w.fighters[i];
    if (f.charId !== 'huhu') continue;
    if (U.cur === i) return 1;
    if (f.ult === 2 && f.move === 'ultimate') return 1;
  }
  return 0;
}
export function drawNight(ctx, w) {
  const target = nightTarget(w);
  nightK += (target - nightK) * 0.12;
  if (target === 0 && nightK < 0.01) nightK = 0;
  if (nightK <= 0) return;
  const k = nightK;
  ctx.save();
  ctx.fillStyle = 'rgba(8,16,64,' + (0.55 * k).toFixed(3) + ')';
  ctx.fillRect(0, 0, 800, 450);
  ctx.globalAlpha = k;
  const now = Date.now();
  for (let i = 0; i < 36; i++) {
    const x = (i * 97 + 31) % 800;
    const y = (i * 61 + 17) % 230;
    const tw = 0.5 + 0.5 * Math.sin(now / 300 + i * 1.7);
    ctx.fillStyle = 'rgba(255,255,220,' + (0.35 + 0.65 * tw).toFixed(3) + ')';
    const sz = i % 5 === 0 ? 3 : 2;
    ctx.fillRect(x, y, sz, sz);
  }
  // 月亮:亮圓減去偏移的暗圓
  ctx.fillStyle = '#f4efc0';
  ctx.beginPath();
  ctx.arc(660, 96, 22, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = '#0c1440';
  ctx.beginPath();
  ctx.arc(670, 90, 19, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

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
    const name = (def.moves.ultimate && def.moves.ultimate.ult && def.moves.ultimate.ult.name) || def.name;
    // 排版:色帶 y 190~340,特寫圖底邊 380、高度上限 290(頂端 >= 90,避開上方 HUD);整體都在 450 高畫面內
    const BAND_Y = 190;
    const BAND_H = 150;
    ctx.fillStyle = def.color;
    ctx.globalAlpha = 0.85 * Math.max(0, fade);
    ctx.fillRect(0, BAND_Y, 800, BAND_H);
    ctx.globalAlpha = 1;
    const cs = cutinSize(f.charId);
    let textX = 430;
    if (cs) {
      const sc = Math.min(2.8, 290 / cs.h, 400 / cs.w);
      drawCutinArt(ctx, f.charId, 230 + dx, 380, sc, false);
    } else {
      // 退回畫法:色帶 + 角色名(大字)+ 大招名
      textX = 60;
      ctx.save();
      ctx.translate(60 + dx, 265);
      ctx.transform(1, 0, -0.18, 1, 0, 0);
      ctx.font = 'bold 64px ' + FONT;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.lineWidth = 7;
      ctx.strokeStyle = 'rgba(0,0,0,0.7)';
      ctx.strokeText(def.name, 0, 0);
      ctx.fillStyle = 'rgba(255,255,255,0.85)';
      ctx.fillText(def.name, 0, 0);
      ctx.restore();
    }
    ctx.save();
    ctx.translate(textX + (cs ? 0 : 0) - dx * 0.6, cs ? 265 : 315);
    ctx.transform(1, 0, -0.18, 1, 0, 0);
    let fs = 44;
    ctx.font = 'bold ' + fs + 'px ' + FONT;
    const maxW = 780 - textX;
    const tm = ctx.measureText && ctx.measureText(name);
    const tw = tm ? tm.width : 0;
    if (tw > maxW) {
      fs = Math.max(20, Math.floor((fs * maxW) / tw));
      ctx.font = 'bold ' + fs + 'px ' + FONT;
    }
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
