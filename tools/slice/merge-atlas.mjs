// 把新切好的圖集(例如必殺技畫格)併入既有圖集:舊畫格像素與錨點完全不動,新圖集接在下面。
// 用法:node tools/slice/merge-atlas.mjs <基底資料夾> <新圖集資料夾> <輸出資料夾>
// 基底 / 新圖集各含 atlas.png + atlas.json;幀名重複時報錯。
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { decodePng, encodePng } from './png.mjs';

const [a, b, o] = process.argv.slice(2);
if (!a || !b || !o) {
  console.log('用法:node tools/slice/merge-atlas.mjs <基底資料夾> <新圖集資料夾> <輸出資料夾>');
  process.exit(1);
}
const base = { json: JSON.parse(readFileSync(resolve(a, 'atlas.json'), 'utf8')), img: decodePng(readFileSync(resolve(a, 'atlas.png'))) };
const add = { json: JSON.parse(readFileSync(resolve(b, 'atlas.json'), 'utf8')), img: decodePng(readFileSync(resolve(b, 'atlas.png'))) };
for (const k in add.json.frames) if (base.json.frames[k]) throw new Error('幀名重複:' + k);
const W = Math.max(base.img.w, add.img.w);
const H = base.img.h + add.img.h;
if (W > 2048 || H > 2048) throw new Error('合併後圖集 ' + W + '×' + H + ' 超過 2048');
const data = new Uint8Array(W * H * 4);
const blit = (img, y0) => {
  for (let r = 0; r < img.h; r++) data.set(img.data.subarray(r * img.w * 4, (r + 1) * img.w * 4), (y0 + r) * W * 4);
};
blit(base.img, 0);
blit(add.img, base.img.h);
const frames = Object.assign({}, base.json.frames);
for (const k in add.json.frames) frames[k] = Object.assign({}, add.json.frames[k], { y: add.json.frames[k].y + base.img.h });
const json = Object.assign({}, base.json, { size: { w: W, h: H }, frames });
mkdirSync(resolve(o), { recursive: true });
writeFileSync(join(resolve(o), 'atlas.png'), encodePng({ w: W, h: H, data }));
writeFileSync(join(resolve(o), 'atlas.json'), JSON.stringify(json, null, 1).split('\n').join('\r\n')); // 倉庫檔案換行用 CRLF
console.log('合併 ' + resolve(o) + ':' + Object.keys(frames).length + ' 格,圖集 ' + W + '×' + H);
