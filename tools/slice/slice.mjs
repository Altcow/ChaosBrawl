// 切圖工具:GPT 精靈表(洋紅底)→ 去背、腳底對齊、打包圖集
// 用法:node tools/slice/slice.mjs <設定.json> [--out 輸出資料夾]
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { decodePng, encodePng } from './png.mjs';

const DEF = {
  cell: { w: 160, h: 160 },
  wideCell: { w: 256, h: 160 },
  footOffset: 8, // 腳底線:畫格底往上 px(輸出像素)
  pxPerUnit: 2, // 圖集像素 / 邏輯像素
  scale: 'auto', // 來源 → 輸出縮放;auto = 畫格高 / 來源格高
  key: { lo: 0.3, hi: 0.8, edge: 2 }, // 洋紅度 < lo 不動;>= hi 全透明;edge = 去色溢帶寬(來源 px)
  alphaMin: 16, // 量邊界框時視為有內容的 alpha 下限
  layout: 'grid', // grid(依格數等分)| components(連通區域)
  mergeGap: 24, // components:相距小於此值(來源 px)的碎塊併為同一格
  minArea: 64, // components:小於此面積的碎塊視為雜點
  pad: 2,
  maxW: 2048,
  maxH: 2048
};

// ---- 去背 ----
// 洋紅度 m = (min(R,B) - G) / 255;純洋紅 = 1,與前景混色時依混合比例下降
// bg:'auto' 時背景色不寫死:取四角色塊雙線性內插當各點背景色(吃 webp 偏色 / 漸層),
// 並把畫格間 lines 條寬 band 內的亮色細線(白 / 粉紅)當背景濾掉(extra = { cols, rows })
function bgModel(img) {
  const { w, h, data } = img;
  const ins = Math.min(10, Math.floor(Math.min(w, h) / 8));
  const ps = Math.min(12, Math.floor(Math.min(w, h) / 8));
  const corner = (x0, y0) => {
    const c = [0, 0, 0];
    for (let y = y0; y < y0 + ps; y++) {
      for (let x = x0; x < x0 + ps; x++) {
        const o = (y * w + x) * 4;
        c[0] += data[o];
        c[1] += data[o + 1];
        c[2] += data[o + 2];
      }
    }
    return c.map((v) => v / (ps * ps));
  };
  const c00 = corner(ins, ins);
  const c10 = corner(w - ins - ps, ins);
  const c01 = corner(ins, h - ins - ps);
  const c11 = corner(w - ins - ps, h - ins - ps);
  return (x, y, out) => {
    const u = x / (w - 1);
    const v = y / (h - 1);
    for (let k = 0; k < 3; k++) out[k] = c00[k] * (1 - u) * (1 - v) + c10[k] * u * (1 - v) + c01[k] * (1 - u) * v + c11[k] * u * v;
  };
}

export function keyOut(img, opt, extra) {
  const { w, h, data } = img;
  const n = w * h;
  let hasAlpha = false;
  for (let i = 0; i < n; i++) {
    if (data[i * 4 + 3] < 250) {
      hasAlpha = true;
      break;
    }
  }
  if (hasAlpha && !opt.forceKey) return { skipped: true };
  const m = new Float32Array(n);
  const seed = new Uint8Array(n);
  const auto = opt.bg === 'auto';
  const bgAt = auto ? bgModel(img) : null;
  const bgc = [255, 0, 255];
  const band = opt.lineBand === undefined ? 4 : opt.lineBand;
  const gx = auto && extra && extra.cols ? w / extra.cols : 0;
  const gy = auto && extra && extra.rows ? h / extra.rows : 0;
  const nearLine = (x, y) => {
    if (!gx) return false;
    const dx = Math.abs(x - Math.round(x / gx) * gx);
    const dy = Math.abs(y - Math.round(y / gy) * gy);
    return dx <= band || dy <= band;
  };
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (auto) {
      const x = i % w;
      const y = (i - x) / w;
      bgAt(x, y, bgc);
      const rn = Math.min(255, (data[o] * 255) / Math.max(1, bgc[0]));
      const bn = Math.min(255, (data[o + 2] * 255) / Math.max(1, bgc[2]));
      const gn = Math.max(0, ((data[o + 1] - bgc[1]) * 255) / Math.max(1, 255 - bgc[1]));
      const v = Math.min(rn, bn) - gn;
      m[i] = v > 0 ? v / 255 : 0;
      if (opt.lines !== false && Math.min(rn, bn) >= 170 && nearLine(x, y)) m[i] = 1;
    } else {
      const v = Math.min(data[o], data[o + 2]) - data[o + 1];
      m[i] = v > 0 ? v / 255 : 0;
    }
    if (m[i] >= opt.hi) seed[i] = 1;
  }
  // 邊緣帶:距離透明種子 <= edge 的像素(Chebyshev)
  let zone = seed;
  for (let r = 0; r < opt.edge; r++) {
    const nz = Uint8Array.from(zone);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (zone[y * w + x]) continue;
        let hit = false;
        for (let dy = -1; dy <= 1 && !hit; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx >= 0 && xx < w && zone[yy * w + xx]) {
              hit = true;
              break;
            }
          }
        }
        if (hit) nz[y * w + x] = 1;
      }
    }
    zone = nz;
  }
  for (let i = 0; i < n; i++) {
    const o = i * 4;
    if (seed[i]) {
      data[o] = data[o + 1] = data[o + 2] = data[o + 3] = 0;
    } else if (zone[i] && m[i] > opt.lo) {
      const mm = m[i];
      const a = Math.max(0, Math.min(1, 1 - (mm - opt.lo) / (opt.hi - opt.lo)));
      // 解混:c = m*K + (1-m)*F,K = (255,0,255)
      const d = 1 - mm;
      if (auto) bgAt(i % w, Math.floor(i / w), bgc);
      data[o] = Math.max(0, Math.min(255, Math.round((data[o] - mm * bgc[0]) / d)));
      data[o + 1] = Math.max(0, Math.min(255, Math.round((data[o + 1] - mm * bgc[1]) / d)));
      data[o + 2] = Math.max(0, Math.min(255, Math.round((data[o + 2] - mm * bgc[2]) / d)));
      data[o + 3] = Math.round(a * 255);
    } else {
      data[o + 3] = 255;
    }
  }
  return { skipped: false };
}

// ---- 取格 ----
function bboxOf(img, x0, y0, x1, y1, amin) {
  let bx0 = 1e9;
  let by0 = 1e9;
  let bx1 = -1;
  let by1 = -1;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      if (img.data[(y * img.w + x) * 4 + 3] >= amin) {
        if (x < bx0) bx0 = x;
        if (x > bx1) bx1 = x;
        if (y < by0) by0 = y;
        if (y > by1) by1 = y;
      }
    }
  }
  return bx1 < 0 ? null : { x0: bx0, y0: by0, x1: bx1 + 1, y1: by1 + 1 };
}

function componentBoxes(img, amin, mergeGap, minArea) {
  const { w, h, data } = img;
  const lab = new Int32Array(w * h);
  const boxes = [];
  const stack = [];
  for (let s = 0; s < w * h; s++) {
    if (lab[s] || data[s * 4 + 3] < amin) continue;
    const id = boxes.length + 1;
    const b = { x0: 1e9, y0: 1e9, x1: -1, y1: -1, area: 0 };
    lab[s] = id;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop();
      const x = p % w;
      const y = (p - x) / w;
      b.area++;
      if (x < b.x0) b.x0 = x;
      if (x > b.x1) b.x1 = x;
      if (y < b.y0) b.y0 = y;
      if (y > b.y1) b.y1 = y;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const q = yy * w + xx;
          if (!lab[q] && data[q * 4 + 3] >= amin) {
            lab[q] = id;
            stack.push(q);
          }
        }
      }
    }
    b.x1++;
    b.y1++;
    b.ids = [id];
    boxes.push(b);
  }
  const list = boxes.filter((b) => b.area >= minArea);
  list.lab = lab; // 標籤圖:切格時用來遮掉落在方框內、但屬於相鄰物件的像素
  // 近距離碎塊合併(例:角色 + 分離的道具)
  let merged = true;
  while (merged) {
    merged = false;
    outer: for (let i = 0; i < list.length; i++) {
      for (let j = i + 1; j < list.length; j++) {
        const a = list[i];
        const b = list[j];
        if (a.x0 - mergeGap < b.x1 && b.x0 - mergeGap < a.x1 && a.y0 - mergeGap < b.y1 && b.y0 - mergeGap < a.y1) {
          list[i] = { x0: Math.min(a.x0, b.x0), y0: Math.min(a.y0, b.y0), x1: Math.max(a.x1, b.x1), y1: Math.max(a.y1, b.y1), area: a.area + b.area, ids: a.ids.concat(b.ids) };
          list.splice(j, 1);
          merged = true;
          break outer;
        }
      }
    }
  }
  return list;
}

// 依列分群再由左而右排序(列容差 = 最高框的一半)
function sortRowMajor(list, rowTol) {
  const byY = list.slice().sort((a, b) => a.y0 + a.y1 - (b.y0 + b.y1));
  const tol = rowTol || Math.max(...list.map((b) => b.y1 - b.y0)) / 2; // rowTol:各列高度差很大時手動指定(來源 px)
  const rows = [];
  for (const b of byY) {
    const cy = (b.y0 + b.y1) / 2;
    const r = rows.find((row) => Math.abs(row.cy - cy) <= tol);
    if (r) {
      r.items.push(b);
      r.cy = r.items.reduce((s, q) => s + (q.y0 + q.y1) / 2, 0) / r.items.length;
    } else rows.push({ cy, items: [b] });
  }
  rows.sort((a, b) => a.cy - b.cy);
  return rows.flatMap((r) => r.items.sort((a, b) => a.x0 - b.x0));
}

// 預乘 alpha 的區域平均縮放
function resample(img, box, ow, oh) {
  const sw = box.x1 - box.x0;
  const sh = box.y1 - box.y0;
  const out = new Uint8Array(ow * oh * 4);
  const fx = sw / ow;
  const fy = sh / oh;
  for (let y = 0; y < oh; y++) {
    const ys = box.y0 + y * fy;
    const ye = ys + fy;
    for (let x = 0; x < ow; x++) {
      const xs = box.x0 + x * fx;
      const xe = xs + fx;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      let area = 0;
      for (let sy = Math.floor(ys); sy < Math.ceil(ye); sy++) {
        const wy = Math.min(sy + 1, ye) - Math.max(sy, ys);
        for (let sx = Math.floor(xs); sx < Math.ceil(xe); sx++) {
          const wgt = wy * (Math.min(sx + 1, xe) - Math.max(sx, xs));
          const o = (Math.min(sy, img.h - 1) * img.w + Math.min(sx, img.w - 1)) * 4;
          const al = img.data[o + 3] * wgt;
          r += img.data[o] * al;
          g += img.data[o + 1] * al;
          b += img.data[o + 2] * al;
          a += al;
          area += wgt;
        }
      }
      const o = (y * ow + x) * 4;
      if (a > 0) {
        out[o] = Math.round(r / a);
        out[o + 1] = Math.round(g / a);
        out[o + 2] = Math.round(b / a);
        out[o + 3] = Math.round(a / area);
      }
    }
  }
  return { w: ow, h: oh, data: out };
}

// 清除面積小於 minArea 的孤立雜點(8 連通;webp 壓縮雜訊 / 殘留線段)
function despeckle(img, amin, minArea) {
  const { w, h, data } = img;
  const lab = new Uint8Array(w * h);
  const stack = [];
  for (let s = 0; s < w * h; s++) {
    if (lab[s] || data[s * 4 + 3] < amin) continue;
    const pix = [];
    lab[s] = 1;
    stack.push(s);
    while (stack.length) {
      const p = stack.pop();
      pix.push(p);
      const x = p % w;
      const y = (p - x) / w;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const q = yy * w + xx;
          if (!lab[q] && data[q * 4 + 3] >= amin) {
            lab[q] = 1;
            stack.push(q);
          }
        }
      }
    }
    if (pix.length < minArea) for (const p of pix) data[p * 4 + 3] = 0;
  }
}

// 腳底中心 x(來源 px):框底部 band 內有內容像素的 x 平均
function feetX(img, b, bandFrac) {
  const hh = b.y1 - b.y0;
  const bandH = Math.max(4, Math.round(hh * bandFrac));
  let sum = 0;
  let cnt = 0;
  for (let y = Math.max(b.y0, b.y1 - bandH); y < b.y1; y++) {
    for (let x = b.x0; x < b.x1; x++) {
      if (img.data[(y * img.w + x) * 4 + 3] >= 16) {
        sum += x + 0.5;
        cnt++;
      }
    }
  }
  return cnt ? sum / cnt : (b.x0 + b.x1) / 2;
}

function normEntry(e) {
  if (e == null) return null;
  return typeof e === 'string' ? { name: e } : e;
}

// config:已解析的設定物件;readImage(file) → { w, h, data }(測試可傳入記憶體圖)
export function sliceSheets(config, readImage) {
  const C = Object.assign({}, DEF, config);
  C.key = Object.assign({}, DEF.key, config.key || {});
  const warnings = [];
  const sprites = []; // { name, img, ax, ay, wide }
  const seen = new Set();
  for (const sheet of config.sheets) {
    const img = readImage(sheet.file);
    const lab = sheet.file;
    const cols = sheet.cols || 1;
    const rows = sheet.rows || 1;
    const ks = keyOut(img, Object.assign({}, C.key, sheet.key || {}), { cols, rows });
    if (ks.skipped) warnings.push(lab + ':已含透明,略過洋紅去背');
    else if (sheet.despeckle) despeckle(img, C.alphaMin, sheet.despeckle);
    const cw = img.w / cols;
    const chh = img.h / rows;
    const entries = (sheet.frames || []).map(normEntry);
    const wanted = entries.filter(Boolean).length;
    const scale = (sheet.scale || C.scale) === 'auto' ? C.cell.h / chh : sheet.scale || C.scale;
    const layout = sheet.layout || C.layout;
    let boxes;
    let compLab = null;
    let owner = null;
    if (layout === 'components') {
      const comps = componentBoxes(img, C.alphaMin, sheet.mergeGap || C.mergeGap, sheet.minArea || C.minArea);
      if (comps.length !== wanted) throw new Error(lab + ':偵測到 ' + comps.length + ' 個連通區域,設定要 ' + wanted + ' 格(調整 mergeGap/minArea,或請 GPT 重畫)');
      boxes = sortRowMajor(comps, sheet.rowTol);
      compLab = comps.lab;
      owner = new Map();
      for (const c of comps) for (const id of c.ids) owner.set(id, c);
    } else {
      boxes = [];
      for (let i = 0; i < entries.length; i++) {
        if (!entries[i]) continue;
        const c = i % cols;
        const r = Math.floor(i / cols);
        if (r >= rows) throw new Error(lab + ':frames 數量超過 ' + cols + '×' + rows + ' 格');
        const x0 = Math.round(c * cw);
        const y0 = Math.round(r * chh);
        const x1 = Math.round((c + 1) * cw);
        const y1 = Math.round((r + 1) * chh);
        const b = bboxOf(img, x0, y0, x1, y1, C.alphaMin);
        if (!b) throw new Error(lab + ':格 ' + entries[i].name + ' 是空的');
        b.cell = { x0, y0, x1, y1 };
        boxes.push(b);
      }
    }
    let bi = 0;
    for (const e of entries) {
      if (!e) continue;
      const b = boxes[bi++];
      if (e.skip) continue; // { "skip": true }:該塊要偵測(算數量與排序)但不輸出
      if (seen.has(e.name)) throw new Error('幀名重複:' + e.name);
      seen.add(e.name);
      const fs = e.scale || scale; // 單格縮放(例如特寫比角色大),沒設就用 sheet 的
      const ow = Math.max(1, Math.round((b.x1 - b.x0) * fs));
      const oh = Math.max(1, Math.round((b.y1 - b.y0) * fs));
      let spr;
      if (compLab) {
        // 方框內屬於「別的物件」的像素(相鄰畫格的武器尖端 / 特效探進來)先遮掉,避免出現在這一格
        const bw = b.x1 - b.x0;
        const bh = b.y1 - b.y0;
        const sub = { w: bw, h: bh, data: new Uint8Array(bw * bh * 4) };
        for (let yy = 0; yy < bh; yy++) {
          for (let xx = 0; xx < bw; xx++) {
            const p = (b.y0 + yy) * img.w + b.x0 + xx;
            const o = (yy * bw + xx) * 4;
            sub.data.set(img.data.subarray(p * 4, p * 4 + 4), o);
            const id = compLab[p];
            if (id && owner.has(id) && owner.get(id) !== b) sub.data[o + 3] = 0;
          }
        }
        spr = resample(sub, { x0: 0, y0: 0, x1: bw, y1: bh }, ow, oh);
      } else spr = resample(img, b, ow, oh);
      const rx = ow / (b.x1 - b.x0);
      const ry = oh / (b.y1 - b.y0);
      let ax;
      let ay;
      const foot = C.footOffset / fs; // 腳底線偏移(來源 px)
      if (layout === 'grid' && e.air) {
        // 空中格:保留畫格幾何,以格底往上 footOffset 為地線
        const lineY = b.cell.y1 - foot;
        ay = (lineY - b.y0) * ry;
      } else {
        if (layout !== 'grid' && e.air) warnings.push(e.name + ':air 只在 grid 版面有效,已改為腳底貼地');
        ay = oh;
      }
      const am = e.anchorX || sheet.anchorX || C.anchorX || (layout === 'grid' ? 'cell' : 'bbox');
      if (am === 'cell' && layout === 'grid') ax = ((b.cell.x0 + b.cell.x1) / 2 - b.x0) * rx;
      else if (am === 'feet') ax = (feetX(img, b, sheet.footBand || C.footBand || 0.08) - b.x0) * rx;
      else if (am === 'left') ax = 0;
      else if (am === 'right') ax = ow;
      else ax = ow / 2;
      if (e.anchorY === 'mid') ay = oh / 2; // 特效:垂直置中 / 頂端(預設為底邊 = 腳底)
      else if (e.anchorY === 'top') ay = 0;
      ax += e.dx || 0;
      ay -= e.dy || 0;
      const wide = !!e.wide;
      const lim = wide ? C.wideCell : C.cell;
      if (ow > lim.w || oh > lim.h) warnings.push(e.name + ':大小 ' + ow + '×' + oh + ' 超過' + (wide ? '寬格 ' : '畫格 ') + lim.w + '×' + lim.h + (wide ? '' : '(若為寬招請標 wide:true)'));
      sprites.push({ name: e.name, img: spr, ax: Math.round(ax * 100) / 100, ay: Math.round(ay * 100) / 100, wide });
    }
  }
  // 貨架式打包
  const order = sprites.slice().sort((a, b) => b.img.h - a.img.h || a.name.localeCompare(b.name));
  const pad = C.pad;
  let x = pad;
  let y = pad;
  let rowH = 0;
  let usedW = 0;
  const pos = new Map();
  for (const s of order) {
    if (x + s.img.w + pad > C.maxW) {
      x = pad;
      y += rowH + pad;
      rowH = 0;
    }
    pos.set(s.name, { x, y });
    x += s.img.w + pad;
    rowH = Math.max(rowH, s.img.h);
    usedW = Math.max(usedW, x);
  }
  const H = y + rowH + pad;
  if (H > C.maxH) throw new Error('圖集高度 ' + H + ' 超過上限 ' + C.maxH + ',請拆成多張');
  const W = usedW;
  const atlas = { w: W, h: H, data: new Uint8Array(W * H * 4) };
  const frames = {};
  for (const s of sprites) {
    const p = pos.get(s.name);
    for (let r = 0; r < s.img.h; r++) {
      atlas.data.set(s.img.data.subarray(r * s.img.w * 4, (r + 1) * s.img.w * 4), ((p.y + r) * W + p.x) * 4);
    }
    frames[s.name] = { x: p.x, y: p.y, w: s.img.w, h: s.img.h, ax: s.ax, ay: s.ay };
    if (s.wide) frames[s.name].wide = true;
  }
  const json = { image: config.image || 'atlas.png', pxPerUnit: C.pxPerUnit, size: { w: W, h: H }, cell: C.cell, wideCell: C.wideCell, footOffset: C.footOffset, frames };
  return { atlas, json, warnings };
}

function main() {
  const args = process.argv.slice(2);
  const cfgPath = args.find((a) => !a.startsWith('--'));
  if (!cfgPath) {
    console.log('用法:node tools/slice/slice.mjs <設定.json> [--out 輸出資料夾]');
    process.exit(1);
  }
  const oi = args.indexOf('--out');
  const cfgFile = resolve(cfgPath);
  const base = dirname(cfgFile);
  const config = JSON.parse(readFileSync(cfgFile, 'utf8').replace(/^﻿/, ''));
  const outDir = oi >= 0 ? resolve(args[oi + 1]) : resolve(base, config.out || 'out');
  const r = sliceSheets(config, (f) => decodePng(readFileSync(resolve(base, f))));
  mkdirSync(outDir, { recursive: true });
  const imgName = config.image || 'atlas.png';
  writeFileSync(join(outDir, imgName), encodePng(r.atlas));
  writeFileSync(join(outDir, 'atlas.json'), JSON.stringify(r.json, null, 1));
  console.log('輸出 ' + outDir + ':' + Object.keys(r.json.frames).length + ' 格,圖集 ' + r.atlas.w + '×' + r.atlas.h);
  for (const w of r.warnings) console.log('警告:' + w);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main();
  } catch (e) {
    console.error('錯誤:' + e.message);
    process.exit(1);
  }
}
