// 測試用:程式生成「GPT 風格」洋紅底精靈表(含與洋紅混色的抗鋸齒邊)
export const CELL = 512; // 來源格 512×512,3 欄 × 2 列 = 1536×1024

function shade(px, py, f, ox, oy) {
  // 回傳 0 = 背景、1 = 外框、2 = 填色;座標為格內像素
  const x = px - f.cx;
  const y = py - f.bottom;
  const inRect = (rx0, ry0, rx1, ry1, g) => x >= rx0 - g && x <= rx1 + g && y >= ry0 - g && y <= ry1 + g;
  const inCirc = (cx, cy, r, g) => (x - cx) * (x - cx) + (y - cy) * (y - cy) <= (r + g) * (r + g);
  const parts = (g) => {
    const bw = f.bodyW / 2;
    if (inRect(-bw, -f.bodyH, bw, 0, g)) return true;
    if (inCirc(f.headDx || 0, -f.bodyH - 70, 80, g)) return true;
    if (f.arm && inRect(bw - 10, -f.bodyH + 20, bw + f.arm, -f.bodyH + 70, g)) return true;
    return false;
  };
  if (parts(0)) return 2;
  if (parts(5)) return 1;
  return 0;
}

// frames: [{ color:[r,g,b], bodyW, bodyH, bottom, cx, arm, headDx }];null = 留空
// 回傳 { w, h, data }
export function makeSheet(frames, cols = 3, rows = 2, opt = {}) {
  const w = CELL * cols;
  const h = CELL * rows;
  const data = new Uint8Array(w * h * 4);
  const SS = 3;
  const dark = [30, 20, 40];
  for (let i = 0; i < w * h; i++) {
    data[i * 4] = 255;
    data[i * 4 + 1] = 0;
    data[i * 4 + 2] = 255;
    data[i * 4 + 3] = 255;
  }
  frames.forEach((f, idx) => {
    if (!f) return;
    const ox = (idx % cols) * CELL;
    const oy = Math.floor(idx / cols) * CELL;
    for (let y = 0; y < CELL; y++) {
      for (let x = 0; x < CELL; x++) {
        let r = 0;
        let g = 0;
        let b = 0;
        let cover = 0;
        for (let sy = 0; sy < SS; sy++) {
          for (let sx = 0; sx < SS; sx++) {
            const s = shade(x + (sx + 0.5) / SS, y + (sy + 0.5) / SS, f);
            if (s === 0) continue;
            const c = s === 2 ? f.color : dark;
            r += c[0];
            g += c[1];
            b += c[2];
            cover++;
          }
        }
        if (!cover) continue;
        const n = SS * SS;
        const o = ((oy + y) * w + ox + x) * 4;
        const k = n - cover; // 洋紅(255,0,255)的樣本數
        data[o] = Math.round((r + k * 255) / n);
        data[o + 1] = Math.round(g / n);
        data[o + 2] = Math.round((b + k * 255) / n);
      }
    }
  });
  if (opt.transparent) {
    for (let i = 0; i < w * h; i++) {
      if (data[i * 4] === 255 && data[i * 4 + 1] === 0 && data[i * 4 + 2] === 255) data[i * 4 + 3] = 0;
    }
  }
  return { w, h, data };
}

export const COLORS = [[240, 160, 48], [60, 160, 220], [120, 200, 80], [220, 80, 80], [250, 240, 120], [90, 90, 90]];
export function frameSpec(i, extra) {
  return Object.assign({ color: COLORS[i % COLORS.length], bodyW: 140, bodyH: 224, bottom: 486, cx: 256 }, extra || {});
}
