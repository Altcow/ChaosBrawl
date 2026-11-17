import { S, STATE_NAMES } from '../sim/fighter.js';
import { FX } from '../core/fixed.js';

// 佔位人形:色塊 + 頭 + 手臂;依狀態改姿勢
const STATE_TINT = {
  [S.HURT]: '#e05050', [S.STUN]: '#d0d040', [S.FALL]: '#e05050'
};

function drawPlaceholder(ctx, f, def, sx, sy, face, hitFlash) {
  const body = def.color;
  const lying = f.state === S.LYING || f.state === S.FALL || f.state === S.GETUP;
  ctx.save();
  ctx.translate(sx, sy);
  // 影子(貼地,不隨跳躍)由呼叫端畫
  if (lying) {
    ctx.rotate((face > 0 ? -1 : 1) * (f.state === S.GETUP ? 0.7 : 1.45));
  } else if (f.state === S.SQUAT) {
    ctx.scale(1.1, 0.85);
  } else if (f.state === S.ROLL) {
    ctx.translate(0, -16);
    ctx.rotate(face * (f.st * 0.7));
    ctx.translate(0, 16);
    ctx.scale(1, 0.55);
  }
  const color = hitFlash ? '#ffffff' : STATE_TINT[f.state] || body;
  ctx.fillStyle = color;
  ctx.fillRect(-12, -46, 24, 34); // 身
  ctx.fillRect(-10, -14, 8, 14); // 腿
  ctx.fillRect(2, -14, 8, 14);
  ctx.fillStyle = '#f2d2a8';
  ctx.beginPath();
  ctx.arc(0, -54, 10, 0, Math.PI * 2); // 頭
  ctx.fill();
  ctx.fillStyle = '#222';
  ctx.fillRect(face > 0 ? 3 : -7, -57, 4, 4); // 眼
  // 手臂
  ctx.strokeStyle = color;
  ctx.lineWidth = 6;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(0, -40);
  if (f.move && f.hf >= 0) ctx.lineTo(face * 38, -34);
  else if (f.state === S.DEFEND) ctx.lineTo(face * 14, -44);
  else if (f.state === S.WALK || f.state === S.RUN) ctx.lineTo(face * 6 * (f.st & 8 ? 1 : -1), -26);
  else ctx.lineTo(face * 4, -26);
  ctx.stroke();
  if (f.state === S.DEFEND) {
    ctx.strokeStyle = '#6cf';
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.arc(face * 16, -30, 24, -1.2, 1.2);
    ctx.stroke();
  }
  ctx.restore();
}

// ---- 逐格精靈圖集 ----
// 角色 json 的 art 欄位:{ atlas, scale, states:{狀態名:動畫}, moves:{招式名:動畫} }
// 動畫 = { mode, frames:[幀名], rate, total, at }
//   loop:依 f.st / rate 迴圈  hold:固定第 1 格(有 rate 時播到最後一格停住)
//   vy:依垂直速度選 上升/(頂點)/下落  progress:依 f.st / total(數字或 def 路徑)平均分格
//   stunt:[輕, 重],f.stunT >= at 用重  move:依招式邏輯格 f.mf(超出取最後一格)
// 圖集不存在、動畫缺漏或幀名不在圖集 → 回傳 null,由呼叫端退回色塊佔位圖。
const DATA_BASE = new URL('../../data/', import.meta.url).href;
const defaultIO = {
  async json(url) {
    const r = await fetch(url);
    if (!r.ok) throw new Error(String(r.status));
    return r.json();
  },
  image(url) {
    return new Promise((res, rej) => {
      const im = new Image();
      im.onload = () => res(im);
      im.onerror = () => rej(new Error('image'));
      im.src = url;
    });
  }
};
let io = defaultIO;
const artCache = new Map(); // charId -> { st:'loading'|'ready'|'none', art, atlas, img }

// 測試用:換掉載入器並清快取
export function setArtIO(next, base) {
  io = next || defaultIO;
  artBase = base || DATA_BASE;
  artCache.clear();
}
let artBase = DATA_BASE;

function loadArt(charId, defArt) {
  const e = { st: 'loading', art: null, atlas: null, img: null };
  artCache.set(charId, e);
  (async () => {
    try {
      const art = defArt || (await io.json(artBase + 'chars/' + charId + '.json')).art;
      if (!art) throw new Error('no art');
      const aUrl = artBase + (art.atlas || 'art/' + charId + '/atlas.json');
      const atlas = await io.json(aUrl);
      const img = await io.image(new URL(atlas.image || 'atlas.png', aUrl).href);
      e.art = art;
      e.atlas = atlas;
      e.img = img;
      e.st = 'ready';
    } catch (err) {
      e.st = 'none';
    }
  })();
  return e;
}

function pathGet(o, p) {
  let v = o;
  for (const k of String(p).split('.')) {
    if (v == null) return 0;
    v = v[k];
  }
  return typeof v === 'number' ? v : 0;
}

// 由狀態與 tick 選幀名;找不到回 null
export function pickFrame(art, f, def) {
  const anim = (f.move && art.moves && art.moves[f.move]) || (art.states && art.states[STATE_NAMES[f.state].toLowerCase()]);
  if (!anim || !anim.frames || !anim.frames.length) return null;
  const fr = anim.frames;
  const n = fr.length;
  const st = f.st || 0;
  let i = 0;
  switch (anim.mode) {
    case 'loop':
      i = Math.floor(st / (anim.rate || 8)) % n;
      break;
    case 'vy': {
      const vy = f.vy / FX;
      if (n === 1) i = 0;
      else if (n === 2) i = vy > 0 ? 0 : 1;
      else i = vy > 1.5 ? 0 : vy < -1.5 ? n - 1 : 1;
      break;
    }
    case 'progress': {
      const total = typeof anim.total === 'number' ? anim.total : pathGet(def, anim.total);
      i = total > 0 ? Math.min(n - 1, Math.floor((st * n) / total)) : 0;
      break;
    }
    case 'stunt':
      i = n > 1 && f.stunT >= (anim.at || 16) ? 1 : 0;
      break;
    case 'move':
      i = Math.min(n - 1, Math.max(0, f.mf));
      break;
    default: // hold
      i = anim.rate ? Math.min(n - 1, Math.floor(st / anim.rate)) : 0;
  }
  return fr[i];
}

const whiteCache = new WeakMap();
function whiteOf(img, fr) {
  let c = whiteCache.get(fr);
  if (c !== undefined) return c;
  c = null;
  try {
    if (typeof document !== 'undefined') {
      c = document.createElement('canvas');
      c.width = fr.w;
      c.height = fr.h;
      const g = c.getContext('2d');
      g.drawImage(img, fr.x, fr.y, fr.w, fr.h, 0, 0, fr.w, fr.h);
      g.globalCompositeOperation = 'source-atop';
      g.fillStyle = '#fff';
      g.fillRect(0, 0, fr.w, fr.h);
    }
  } catch (e) {
    c = null;
  }
  whiteCache.set(fr, c);
  return c;
}

// 回傳 true = 已用圖集畫出
function drawArt(ctx, f, def, sx, sy, face, hitFlash) {
  let e = artCache.get(f.charId);
  if (!e) e = loadArt(f.charId, def && def.art);
  if (e.st !== 'ready') return false;
  const name = pickFrame(e.art, f, def);
  const fr = name && e.atlas.frames && e.atlas.frames[name];
  if (!fr) return false;
  const k = e.art.scale || 1 / (e.atlas.pxPerUnit || 2);
  ctx.save();
  ctx.translate(sx, sy);
  if (face < 0) ctx.scale(-1, 1);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  const src = hitFlash ? whiteOf(e.img, fr) : null;
  if (src) ctx.drawImage(src, 0, 0, fr.w, fr.h, -fr.ax * k, -fr.ay * k, fr.w * k, fr.h * k);
  else ctx.drawImage(e.img, fr.x, fr.y, fr.w, fr.h, -fr.ax * k, -fr.ay * k, fr.w * k, fr.h * k);
  ctx.restore();
  return true;
}

// 射彈 / 道具圖:art.projectiles.<射彈名> = { frames:[幀名], rate };以圖集格中心對準射彈座標。
// 回傳 true = 已畫;沒有圖集或設定就回 false,由呼叫端畫色塊。
export function drawProjectileArt(ctx, charId, kind, tick, sx, sy, face) {
  const e = artCache.get(charId);
  if (!e || e.st !== 'ready') return false;
  const a = e.art.projectiles && e.art.projectiles[kind];
  if (!a || !a.frames || !a.frames.length) return false;
  const name = a.frames[Math.floor(tick / (a.rate || 4)) % a.frames.length];
  const fr = e.atlas.frames && e.atlas.frames[name];
  if (!fr) return false;
  const k = (e.art.scale || 1 / (e.atlas.pxPerUnit || 2)) * (a.scale || 1); // a.scale:射彈圖放大倍率(E2,例如大龍捲沿用小龍捲圖)
  ctx.save();
  ctx.translate(sx, sy);
  if (face < 0) ctx.scale(-1, 1);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(e.img, fr.x, fr.y, fr.w, fr.h, (-fr.w * k) / 2, (-fr.h * k) / 2, fr.w * k, fr.h * k);
  ctx.restore();
  return true;
}

export function drawFighter(ctx, f, def, sx, sy, face, hitFlash) {
  if (!drawArt(ctx, f, def, sx, sy, face, hitFlash)) drawPlaceholder(ctx, f, def, sx, sy, face, hitFlash);
}

// 特寫圖原始尺寸(未載入 / 沒有 art.cutin = null),供特寫排版算縮放
export function cutinSize(charId) {
  const e = artCache.get(charId);
  if (!e || e.st !== 'ready' || !e.art.cutin) return null;
  const fr = e.atlas.frames && e.atlas.frames[e.art.cutin.frame];
  return fr ? { w: fr.w, h: fr.h } : null;
}

// 特寫圖:art.cutin = { frame };畫在 (cx, cy)(圖的底邊中心),scale 為放大倍率。圖集 / 幀缺漏回傳 false
export function drawCutinArt(ctx, charId, cx, cy, scale, flip) {
  const e = artCache.get(charId);
  if (!e || e.st !== 'ready' || !e.art.cutin) return false;
  const fr = e.atlas.frames && e.atlas.frames[e.art.cutin.frame];
  if (!fr) return false;
  ctx.save();
  ctx.translate(cx, cy);
  if (flip) ctx.scale(-1, 1);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(e.img, fr.x, fr.y, fr.w, fr.h, (-fr.w * scale) / 2, -fr.h * scale, fr.w * scale, fr.h * scale);
  ctx.restore();
  return true;
}

// 招式特效掛圖:art.fx.<招式名> = 物件或物件陣列(同一招可掛多組),每組 { frames, rate, from(邏輯格起算)、to(最後一格,含;沒設就到招式結束)、
//   dx(朝向前為正)、dy(往上位移 px,刀光 / 光束 / 頭頂光球用)、scale、sx(只橫向拉長倍率)、under(畫在角色底下) }
// 只讀圖集;沒有設定 / 圖集未載入 / 幀名不在圖集就什麼都不畫(退回現狀)。純畫面,不影響模擬與連線同步
export function drawMoveFx(ctx, f, def, sx, sy, face, under) {
  if (!f.move || (f.hf < 0 && !(f.hitstop > 0))) return; // 命中停頓那幾 tick hf 會被清成 -1,特效照畫(不然一打中特效就閃掉)
  const e = artCache.get(f.charId);
  if (!e || e.st !== 'ready') return;
  const list = e.art.fx && e.art.fx[f.move];
  if (!list) return;
  for (const a of [].concat(list)) {
    if (!a || !!a.under !== !!under || !a.frames || !a.frames.length || f.mf < (a.from || 0)) continue;
    if (a.to !== undefined && f.mf > a.to) continue;
    const name = a.frames[Math.floor((f.mtot || 0) / (a.rate || 6)) % a.frames.length];
    const fr = e.atlas.frames && e.atlas.frames[name];
    if (!fr) continue;
    const k = (e.art.scale || 1 / (e.atlas.pxPerUnit || 2)) * (a.scale || 1);
    const kx = k * (a.sx || 1); // sx:只橫向拉長(貼地長特效,例如衝擊波 / 水柱 / 地震波)
    ctx.save();
    ctx.translate(sx + face * (a.dx || 0), sy - (a.dy || 0));
    if (face < 0) ctx.scale(-1, 1);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(e.img, fr.x, fr.y, fr.w, fr.h, -fr.ax * kx, -fr.ay * k, fr.w * kx, fr.h * k);
    ctx.restore();
  }
}
