// 切圖工具測試:node tools/slice/test/run-test.mjs(圖全由程式生成,不需真實 GPT 圖)
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sliceSheets } from '../slice.mjs';
import { decodePng, encodePng } from '../png.mjs';
import { makeSheet, frameSpec } from './fake.mjs';

const here = dirname(fileURLToPath(import.meta.url));
let pass = 0;
let fail = 0;
function check(name, ok, info) {
  if (ok) pass++;
  else fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== undefined ? '  (' + info + ')' : ''));
}

// ---- PNG 往返 ----
{
  const s = makeSheet([frameSpec(0)], 3, 2);
  const back = decodePng(encodePng(s));
  let same = back.w === s.w && back.h === s.h;
  for (let i = 0; same && i < s.data.length; i++) if (s.data[i] !== back.data[i]) same = false;
  check('PNG 編碼/解碼往返一致', same);
}

// ---- grid:洋紅去背 + 腳底對齊 + 空中格 + 寬格 ----
const sheet1 = makeSheet([
  frameSpec(0, { bottom: 486 }), // 0 idle_0
  frameSpec(1, { bottom: 470 }), // 1 idle_1(腳位置不同,仍須貼地)
  frameSpec(2, { cx: 200 }), // 2 walk_0(身體偏左,錨點應偏格中心)
  frameSpec(3, { arm: 120 }), // 3 atk_0(伸臂,寬度變大)
  frameSpec(4, { bottom: 380 }), // 4 jump_up(空中,畫在較高處)
  null // 5 留空
]);
const cfg = {
  sheets: [{ file: 'mem', cols: 3, rows: 2, frames: ['idle_0', 'idle_1', 'walk_0', 'atk_0', { name: 'jump_up', air: true }, null] }]
};
const r = sliceSheets(cfg, () => ({ w: sheet1.w, h: sheet1.h, data: Uint8Array.from(sheet1.data) }));
const F = r.json.frames;
check('輸出 5 格', Object.keys(F).length === 5, Object.keys(F).join(','));
check('無警告', r.warnings.length === 0, r.warnings.join(' | '));
check('地面格高約 120(縮放 0.3125)', Math.abs(F.idle_0.h - 122) <= 3, F.idle_0.h);
check('地面格 ay = 高(腳貼底)', F.idle_0.ay === F.idle_0.h && F.idle_1.ay === F.idle_1.h);
check('空中格 ay > 高(地線在內容下方)', F.jump_up.ay > F.jump_up.h + 15, F.jump_up.ay + ' vs h ' + F.jump_up.h);
// 空中格:cell 底 = 512,腳線 = 512-25.6;內容底 = 380+5 → 地線距內容底約 (486-... ) 以輸出像素 ≈ (512-25.6-385)*0.3125 = 31.7
check('空中格偏移量正確', Math.abs(F.jump_up.ay - F.jump_up.h - 31.7) <= 1.5, (F.jump_up.ay - F.jump_up.h).toFixed(1));
check('錨點 x:置中角色 ≈ 寬一半', Math.abs(F.idle_0.ax - F.idle_0.w / 2) <= 1.5, F.idle_0.ax + ' / ' + F.idle_0.w);
check('錨點 x:偏左角色 < 寬一半之外移', F.walk_0.ax > F.walk_0.w / 2 + 10, F.walk_0.ax + ' / ' + F.walk_0.w);
check('伸臂格較寬', F.atk_0.w > F.idle_0.w + 25, F.atk_0.w + ' vs ' + F.idle_0.w);
check('atlas.json 含必要欄位', r.json.pxPerUnit === 2 && r.json.size.w === r.atlas.w && r.json.image === 'atlas.png');

// 圖集像素:不得殘留洋紅
{
  const A = r.atlas;
  let bad = 0;
  let semi = 0;
  for (const k in F) {
    const f = F[k];
    for (let y = f.y; y < f.y + f.h; y++) {
      for (let x = f.x; x < f.x + f.w; x++) {
        const o = (y * A.w + x) * 4;
        const a = A.data[o + 3];
        if (a === 0 || a === 255) {
          if (a === 0) continue;
        } else semi++;
        if (a >= 40 && Math.min(A.data[o], A.data[o + 2]) - A.data[o + 1] > 0.3 * 255) bad++;
      }
    }
  }
  check('去背後無洋紅殘邊', bad === 0, 'bad=' + bad);
  check('邊緣有抗鋸齒半透明', semi > 50, 'semi=' + semi);
  // 各格不重疊、間隔 ≥ pad
  const list = Object.values(F);
  let ov = false;
  for (let i = 0; i < list.length; i++) {
    for (let j = i + 1; j < list.length; j++) {
      const a = list[i];
      const b = list[j];
      if (a.x < b.x + b.w + 2 && b.x < a.x + a.w + 2 && a.y < b.y + b.h + 2 && b.y < a.y + a.h + 2) ov = true;
    }
  }
  check('圖集各格不重疊(含 2px 間隔)', !ov);
  mkdirSync(join(here, 'out'), { recursive: true });
  writeFileSync(join(here, 'out', 'atlas.png'), encodePng(A));
  writeFileSync(join(here, 'out', 'atlas.json'), JSON.stringify(r.json, null, 1));
}

// ---- 去背:純洋紅區域應全透明(角落像素) ----
{
  const first = F.idle_0;
  const o = (first.y * r.atlas.w + first.x) * 4;
  check('內容框角落(背景)透明', r.atlas.data[o + 3] < 40, r.atlas.data[o + 3]);
}

// ---- 已透明輸入:略過去背 ----
{
  const t = makeSheet([frameSpec(0)], 3, 2, { transparent: true });
  const rr = sliceSheets({ sheets: [{ file: 'm', cols: 3, rows: 2, frames: ['a'] }] }, () => ({ w: t.w, h: t.h, data: Uint8Array.from(t.data) }));
  check('透明輸入可用並提示略過去背', rr.warnings.some((w) => w.includes('略過')) && rr.json.frames.a.h > 100);
}

// ---- components 版面:格線不整齊、碎塊合併 ----
{
  // 3 個角色隨意錯位排列於 3×2 格,另加一個與角色相鄰的小碎塊(道具)
  const s = makeSheet([frameSpec(0, { bottom: 420 }), frameSpec(1, { bottom: 470, cx: 270 }), frameSpec(2, { bottom: 440, cx: 240 }), null, frameSpec(3, { bottom: 480 }), null]);
  // 在第 5 格(idx 4)角色右側 20px 處畫一塊 30×30 道具(與角色分離)
  const ox = 512;
  const oy = 512;
  for (let y = 400; y < 430; y++) {
    for (let x = 345; x < 375; x++) {
      const o = ((oy + y) * s.w + ox + x) * 4;
      s.data[o] = 200;
      s.data[o + 1] = 200;
      s.data[o + 2] = 0;
    }
  }
  const rr = sliceSheets({ sheets: [{ file: 'm', cols: 3, rows: 2, layout: 'components', mergeGap: 40, frames: ['c0', 'c1', 'c2', 'c3', null, null] }] }, () => ({ w: s.w, h: s.h, data: Uint8Array.from(s.data) }));
  check('components 切出 4 格並依列序命名', Object.keys(rr.json.frames).join(',') === 'c0,c1,c2,c3', Object.keys(rr.json.frames).join(','));
  check('components 腳貼底', rr.json.frames.c0.ay === rr.json.frames.c0.h);
  let threw = false;
  try {
    sliceSheets({ sheets: [{ file: 'm', cols: 3, rows: 2, layout: 'components', mergeGap: 40, frames: ['c0', 'c1', 'c2'] }] }, () => ({ w: s.w, h: s.h, data: Uint8Array.from(s.data) }));
  } catch (e) {
    threw = /連通區域/.test(e.message);
  }
  check('components 數量不符時報錯', threw);
}

// ---- 錯誤與警告 ----
{
  let msg = '';
  try {
    sliceSheets({ sheets: [{ file: 'm', cols: 3, rows: 2, frames: ['a', 'a'] }] }, () => ({ w: sheet1.w, h: sheet1.h, data: Uint8Array.from(sheet1.data) }));
  } catch (e) {
    msg = e.message;
  }
  check('幀名重複報錯', msg.includes('重複'), msg);
  msg = '';
  try {
    sliceSheets({ sheets: [{ file: 'm', cols: 3, rows: 2, frames: [null, null, null, null, null, 'x'] }] }, () => ({ w: sheet1.w, h: sheet1.h, data: Uint8Array.from(sheet1.data) }));
  } catch (e) {
    msg = e.message;
  }
  check('空格報錯', msg.includes('空'), msg);
  const wideSheet = makeSheet([frameSpec(0, { arm: 330, cx: 100 })]);
  const w1 = sliceSheets({ sheets: [{ file: 'm', cols: 3, rows: 2, frames: ['w'], scale: 0.4 }] }, () => ({ w: wideSheet.w, h: wideSheet.h, data: Uint8Array.from(wideSheet.data) }));
  const w2 = sliceSheets({ sheets: [{ file: 'm', cols: 3, rows: 2, frames: [{ name: 'w', wide: true }], scale: 0.4 }] }, () => ({ w: wideSheet.w, h: wideSheet.h, data: Uint8Array.from(wideSheet.data) }));
  check('超寬格未標 wide 時警告,標了就不警告', w1.warnings.some((x) => x.includes('超過')) && w2.warnings.length === 0 && w2.json.frames.w.wide === true, w1.warnings.join('|'));
}

// ---- bg:auto(偏色背景 + 畫格細線 + 雜點)+ anchorX:feet ----
{
  const W = 400;
  const H = 200;
  const d = new Uint8Array(W * H * 4);
  const put = (x, y, r, g, b) => {
    const o = (y * W + x) * 4;
    d[o] = r;
    d[o + 1] = g;
    d[o + 2] = b;
    d[o + 3] = 255;
  };
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) put(x, y, 180, 2, 150);
  for (let y = 0; y < H; y++) for (let x = 198; x < 202; x++) put(x, y, 255, 200, 255); // 畫格線
  for (let y = 40; y < 180; y++) for (let x = 60; x < 100; x++) put(x, y, 30, 120, 40); // 角色 1:身體
  for (let y = 170; y < 180; y++) for (let x = 60; x < 140; x++) put(x, y, 30, 120, 40); // 腳伸向右
  for (let y = 40; y < 180; y++) for (let x = 260; x < 300; x++) put(x, y, 30, 120, 40); // 角色 2
  put(20, 20, 30, 30, 30); // 雜點
  const rr = sliceSheets({ scale: 1, anchorX: 'feet', key: { bg: 'auto' }, sheets: [{ file: 'm', cols: 2, rows: 1, despeckle: 10, frames: ['a', 'b'] }] }, () => ({ w: W, h: H, data: Uint8Array.from(d) }));
  const A = rr.json.frames.a;
  const B = rr.json.frames.b;
  check('bg:auto 偏色背景去背,畫格線與雜點不入框', A.w === 80 && A.h === 140 && B.w === 40 && B.h === 140, A.w + 'x' + A.h + ' / ' + B.w + 'x' + B.h);
  check('anchorX:feet 取底部像素中心', Math.abs(A.ax - 40) <= 1.5, A.ax);
}

// ---- CLI 端到端(寫 PNG + 設定檔 → 執行 → 讀回) ----
{
  const { execFileSync } = await import('node:child_process');
  mkdirSync(join(here, 'cli'), { recursive: true });
  writeFileSync(join(here, 'cli', 'sheet1.png'), encodePng(sheet1));
  writeFileSync(join(here, 'cli', 'config.json'), JSON.stringify({ id: 'demo', out: '../out-cli', sheets: [{ file: 'sheet1.png', cols: 3, rows: 2, frames: ['idle_0', 'idle_1', 'walk_0', 'atk_0', { name: 'jump_up', air: true }, null] }] }, null, 1));
  const out = execFileSync(process.execPath, [join(here, '..', 'slice.mjs'), join(here, 'cli', 'config.json')], { encoding: 'utf8' });
  const aj = JSON.parse(readFileSync(join(here, 'out-cli', 'atlas.json'), 'utf8'));
  const ap = decodePng(readFileSync(join(here, 'out-cli', 'atlas.png')));
  check('CLI 端到端輸出圖集', Object.keys(aj.frames).length === 5 && ap.w === aj.size.w && ap.h === aj.size.h, out.trim().split('\n')[0]);
}

console.log('\n' + pass + ' PASS / ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
