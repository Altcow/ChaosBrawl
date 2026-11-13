// 渲染端圖集測試:node tools/slice/test/render-test.mjs
// 用程式生成假圖集(寫到 test/fake-art/ada/,不放 data/art),以假 ctx 記錄繪圖呼叫
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { sliceSheets } from '../slice.mjs';
import { encodePng } from '../png.mjs';
import { makeSheet, frameSpec } from './fake.mjs';
import { drawFighter, setArtIO, pickFrame } from '../../../js/render/sprites.js';
import { compileChar, S } from '../../../js/sim/fighter.js';
import { FX } from '../../../js/core/fixed.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
let pass = 0;
let fail = 0;
function check(name, ok, info) {
  if (ok) pass++;
  else fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== undefined ? '  (' + info + ')' : ''));
}

const adaJson = JSON.parse(readFileSync(join(root, 'tools/fixtures/chars/ada.json'), 'utf8'));
const def = compileChar(adaJson);

// 由 ada.json 的 art 欄位收集所有幀名,生成假圖集
const names = new Set();
for (const g of [adaJson.art.states, adaJson.art.moves]) for (const k in g) g[k].frames.forEach((n) => names.add(n));
const list = [...names];
const sheets = [];
for (let i = 0; i < list.length; i += 6) {
  const chunk = list.slice(i, i + 6);
  sheets.push({ file: 's' + i, cols: 3, rows: 2, frames: chunk.map((n) => ({ name: n, air: /jump|fall/.test(n) })), specs: chunk.map((n, j) => frameSpec(i + j)) });
}
const made = new Map(sheets.map((s) => [s.file, makeSheet(s.specs)]));
const res = sliceSheets({ sheets: sheets.map(({ file, cols, rows, frames }) => ({ file, cols, rows, frames })) }, (f) => {
  const m = made.get(f);
  return { w: m.w, h: m.h, data: Uint8Array.from(m.data) };
});
mkdirSync(join(here, 'fake-art', 'ada'), { recursive: true });
writeFileSync(join(here, 'fake-art', 'ada', 'atlas.png'), encodePng(res.atlas));
writeFileSync(join(here, 'fake-art', 'ada', 'atlas.json'), JSON.stringify(res.json, null, 1));
check('假圖集涵蓋 ada.json art 的所有幀名', Object.keys(res.json.frames).length === list.length, list.length + ' 格');

// ---- 假 ctx / IO ----
function mkCtx() {
  const calls = [];
  const rec = (n) => (...a) => calls.push([n, ...a]);
  return {
    calls,
    save: rec('save'), restore: rec('restore'), translate: rec('translate'), scale: rec('scale'), rotate: rec('rotate'),
    drawImage: rec('drawImage'), fillRect: rec('fillRect'), beginPath: rec('beginPath'), arc: rec('arc'), fill: rec('fill'),
    moveTo: rec('moveTo'), lineTo: rec('lineTo'), stroke: rec('stroke')
  };
}
const IMG = { fake: 'img' };
let missingAtlas = new Set();
const io = {
  async json(url) {
    if (url.endsWith('chars/ada.json')) return adaJson;
    if (url.endsWith('chars/cat.json')) return JSON.parse(JSON.stringify({ art: { atlas: 'art/cat/atlas.json', states: {}, moves: {} } }));
    if (url.endsWith('art/ada/atlas.json')) return JSON.parse(JSON.stringify(res.json));
    throw new Error('404 ' + url);
  },
  async image() {
    return IMG;
  }
};
const settle = () => new Promise((r) => setTimeout(r, 20));
const fighter = (o) => Object.assign({ charId: 'ada', state: S.IDLE, st: 0, vy: 0, mf: 0, move: null, stunT: 0 }, o);
const F = res.json.frames;
const lastDraw = (c) => c.calls.filter((x) => x[0] === 'drawImage').pop();

setArtIO(io, 'mem://data/');
{
  const c = mkCtx();
  drawFighter(c, fighter(), def, 100, 200, 1, false);
  check('圖集載入前:退回色塊佔位圖,不報錯', !c.calls.some((x) => x[0] === 'drawImage') && c.calls.some((x) => x[0] === 'fillRect'));
}
await settle();
{
  const c = mkCtx();
  drawFighter(c, fighter(), def, 100, 200, 1, false);
  const d = lastDraw(c);
  const fr = F.idle_0;
  check('載入後 idle 用 idle_0 圖集矩形', d && d[1] === IMG && d[2] === fr.x && d[3] === fr.y && d[4] === fr.w && d[5] === fr.h);
  check('錨點 + scale 0.5:目的位置 = -ax*0.5, -ay*0.5', d && d[6] === -fr.ax * 0.5 && d[7] === -fr.ay * 0.5 && d[8] === fr.w * 0.5, d && d.slice(6).join(','));
  check('朝右不翻轉', !c.calls.some((x) => x[0] === 'scale'));
  const c2 = mkCtx();
  drawFighter(c2, fighter(), def, 100, 200, -1, false);
  check('朝左水平翻轉 scale(-1,1)', c2.calls.some((x) => x[0] === 'scale' && x[1] === -1 && x[2] === 1));
  check('不旋轉', !c.calls.some((x) => x[0] === 'rotate') && !c2.calls.some((x) => x[0] === 'rotate'));
  const c3 = mkCtx();
  drawFighter(c3, fighter({ state: S.LYING }), def, 100, 200, 1, false);
  check('倒地用 lying_0 且不旋轉', lastDraw(c3)[2] === F.lying_0.x && !c3.calls.some((x) => x[0] === 'rotate'));
  const c4 = mkCtx();
  drawFighter(c4, fighter(), def, 100, 200, 1, true);
  check('受擊閃白:無 document 時仍畫圖不報錯', !!lastDraw(c4));
}

// ---- 選幀邏輯 ----
const art = adaJson.art;
const pf = (o) => pickFrame(art, fighter(o), def);
check('idle 每 24 tick 換格', pf({ st: 0 }) === 'idle_0' && pf({ st: 24 }) === 'idle_1' && pf({ st: 48 }) === 'idle_0');
check('walk 每 8 tick、4 格迴圈', pf({ state: S.WALK, st: 8 }) === 'walk_1' && pf({ state: S.WALK, st: 32 }) === 'walk_0');
check('run 每 5 tick', pf({ state: S.RUN, st: 10 }) === 'run_2');
check('jump 依 vy:上升/下落', pf({ state: S.JUMP, vy: 3 * FX }) === 'jump_up' && pf({ state: S.JUMP, vy: -3 * FX }) === 'jump_down');
check('fall 依 vy', pf({ state: S.FALL, vy: 5 * FX }) === 'fall_up' && pf({ state: S.FALL, vy: -1 * FX }) === 'fall_down');
check('roll 依 roll.dur 平均分 3 格', pf({ state: S.ROLL, st: 0 }) === 'roll_0' && pf({ state: S.ROLL, st: 12 }) === 'roll_1' && pf({ state: S.ROLL, st: 23 }) === 'roll_2');
check('getup 依 getup 時長分 2 格', pf({ state: S.GETUP, st: 3 }) === 'getup_0' && pf({ state: S.GETUP, st: 12 }) === 'getup_1');
check('hurt 輕/重依 stunT', pf({ state: S.HURT, stunT: 12 }) === 'hurt_light' && pf({ state: S.HURT, stunT: 20 }) === 'hurt_heavy');
check('攻擊依招式邏輯格 mf', pf({ state: S.ATTACK, move: 'attack1', mf: 1 }) === 'attack1_1' && pf({ state: S.ATTACK, move: 'attack1', mf: 2 }) === 'attack1_1');
check('跳攻(state=JUMP + move)走招式表', pf({ state: S.JUMP, move: 'jumpatk', mf: 0 }) === 'jumpatk_0');
check('必殺 SPECIAL', pf({ state: S.SPECIAL, move: 'sp_up_atk', mf: 2 }) === 'sp_up_atk_2');
check('stun 迴圈', pf({ state: S.STUN, st: 10 }) === 'stun_1');
check('招式無對照時退回狀態表', pf({ state: S.ATTACK, move: 'nope', mf: 0 }) === null);
check('死亡 / 蹲 / 防', pf({ state: S.DEAD }) === 'lying_0' && pf({ state: S.SQUAT }) === 'squat_0' && pf({ state: S.DEFEND }) === 'defend_0');

// ---- 缺漏退回 ----
{
  const c = mkCtx();
  drawFighter(c, fighter({ state: S.ATTACK, move: 'nope', mf: 0 }), def, 100, 200, 1, false);
  check('缺招式對照:退回佔位圖不報錯', !c.calls.some((x) => x[0] === 'drawImage') && c.calls.some((x) => x[0] === 'fillRect'));
}
{
  // 圖集缺某一幀
  setArtIO({ ...io, async json(u) { const j = await io.json(u); if (u.endsWith('atlas.json')) delete j.frames.walk_1; return j; } }, 'mem://data/');
  await (async () => drawFighter(mkCtx(), fighter(), def, 0, 0, 1, false))();
  await settle();
  const c = mkCtx();
  drawFighter(c, fighter({ state: S.WALK, st: 8 }), def, 100, 200, 1, false);
  const c2 = mkCtx();
  drawFighter(c2, fighter({ state: S.WALK, st: 0 }), def, 100, 200, 1, false);
  check('圖集缺某幀:該格退回佔位圖,其餘幀照常', !c.calls.some((x) => x[0] === 'drawImage') && c2.calls.some((x) => x[0] === 'drawImage'));
}
{
  // 找不到圖集(cat 沒有 atlas)與載入失敗
  setArtIO(io, 'mem://data/');
  const cd = compileChar(JSON.parse(readFileSync(join(root, 'tools/fixtures/chars/cat.json'), 'utf8')));
  const c = mkCtx();
  drawFighter(c, fighter({ charId: 'cat' }), cd, 100, 200, 1, false);
  await settle();
  const c2 = mkCtx();
  drawFighter(c2, fighter({ charId: 'cat' }), cd, 100, 200, 1, false);
  check('找不到圖集(404):持續使用佔位圖,不報錯', !c2.calls.some((x) => x[0] === 'drawImage') && c2.calls.some((x) => x[0] === 'fillRect'));
  const c3 = mkCtx();
  drawFighter(c3, fighter({ charId: 'grandma' }), compileChar(JSON.parse(readFileSync(join(root, 'tools/fixtures/chars/grandma.json'), 'utf8'))), 1, 1, 1, false);
  await settle();
  check('角色 json 無法載入:佔位圖', c3.calls.some((x) => x[0] === 'fillRect'));
}

console.log('\n' + pass + ' PASS / ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
