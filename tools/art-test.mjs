// 角色美術接線檢查:node tools/art-test.mjs
// 每個角色 json 的 art.moves / projectiles / fx / cutin 引用的幀名都要在圖集裡;必殺技(sp_*、ultimate)的 move 模式幀數要等於招式邏輯格數;
// 招式 spawn 的射彈都有對應畫格;fx 的 from / to 不超出招式格數。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { setArtIO, drawFighter, drawMoveFx, drawProjectileArt, pickFrame } from '../js/render/sprites.js';
import { compileChar } from '../js/sim/fighter.js';
import { createWorld, stepWorld } from '../js/sim/world.js';
import { commandMacro, ULT_MACRO } from '../js/sim/command.js';
import { RAGE_MAX } from '../js/sim/ult.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ids = JSON.parse(readFileSync(join(root, 'data/chars/index.json'), 'utf8'));
let pass = 0;
let fail = 0;
const ok = (c, m) => {
  console.log((c ? 'PASS ' : 'FAIL ') + m);
  c ? pass++ : fail++;
};
for (const id of ids) {
  const j = JSON.parse(readFileSync(join(root, 'data/chars/' + id + '.json'), 'utf8'));
  const atlas = JSON.parse(readFileSync(join(root, 'data', j.art.atlas), 'utf8'));
  const has = (n) => !!atlas.frames[n];
  const missing = [];
  const use = (n, where) => {
    if (!has(n)) missing.push(where + ':' + n);
  };
  for (const [s, a] of Object.entries(j.art.states || {})) for (const n of a.frames) use(n, 'states.' + s);
  for (const [m, a] of Object.entries(j.art.moves || {})) for (const n of a.frames) use(n, 'moves.' + m);
  for (const [p, a] of Object.entries(j.art.projectiles || {})) for (const n of a.frames) use(n, 'projectiles.' + p);
  for (const [m, list] of Object.entries(j.art.fx || {})) for (const a of [].concat(list)) for (const n of a.frames) use(n, 'fx.' + m);
  if (j.art.cutin) use(j.art.cutin.frame, 'cutin');
  ok(missing.length === 0, id + ' 美術引用的幀名都在圖集裡' + (missing.length ? '  缺:' + missing.join(', ') : ''));

  const special = Object.keys(j.moves).filter((m) => /^sp_/.test(m) || m === 'ultimate' || m === 'ultimate_lock');
  const noArt = special.filter((m) => !(j.art.moves && j.art.moves[m]));
  ok(noArt.length === 0, id + ' 每個必殺技 / 最強必殺技都有專屬畫格設定' + (noArt.length ? '  缺:' + noArt.join(', ') : ''));
  const badLen = special.filter((m) => j.art.moves[m] && j.art.moves[m].mode === 'move' && j.art.moves[m].frames.length !== j.moves[m].frames.length);
  ok(badLen.length === 0, id + ' 必殺技畫格數 = 招式邏輯格數' + (badLen.length ? '  不符:' + badLen.map((m) => m + '(' + j.art.moves[m].frames.length + '/' + j.moves[m].frames.length + ')').join(', ') : ''));

  const spawned = new Set();
  for (const m of Object.values(j.moves)) for (const f of m.frames) if (f.spawn) for (const sp of [].concat(f.spawn)) spawned.add(sp.proj);
  const noProj = [...spawned].filter((p) => !(j.art.projectiles && j.art.projectiles[p]));
  ok(noProj.length === 0, id + ' 招式 spawn 的射彈都有畫格' + (noProj.length ? '  缺:' + noProj.join(', ') : ''));

  const badFx = [];
  for (const [m, list] of Object.entries(j.art.fx || {})) {
    const n = j.moves[m] ? j.moves[m].frames.length : 0;
    for (const a of [].concat(list)) if (!n || (a.from || 0) >= n || (a.to !== undefined && (a.to >= n || a.to < (a.from || 0)))) badFx.push(m);
  }
  ok(badFx.length === 0, id + ' fx 的 from / to 在招式格數內' + (badFx.length ? '  不符:' + badFx.join(', ') : ''));
}
// ---- 實戰跑一遍:每個角色每招(含最強必殺技)每個 tick 選到的畫格都存在於圖集(不會退回色塊)----
{
  const chars = {};
  for (const id of ids) chars[id] = JSON.parse(readFileSync(join(root, 'data/chars/' + id + '.json'), 'utf8'));
  for (const id of ids) {
    const j = chars[id];
    const atlas = JSON.parse(readFileSync(join(root, 'data', j.art.atlas), 'utf8'));
    const cmds = Object.keys(j.moves).filter((m) => /^sp_/.test(m)).concat(['ult']);
    const bad = [];
    const seenMoves = new Set();
    for (const cmd of cmds) {
      for (const dx of [60, 500]) {
        const w = createWorld({ chars, seed: 5, ult: true, stage: { w: 1600, d: 240 }, spawns: [{ charId: id, kind: 'human', x: 400, z: 100, face: 1 }, { charId: id, kind: 'post', x: 400 + dx, z: 100, face: -1 }] });
        const f = w.fighters[0];
        f.mp = w.defs[id].mp;
        f.rage = RAGE_MAX;
        const mac = cmd === 'ult' ? ULT_MACRO : commandMacro(cmd, f.face);
        for (let t = 0; t < 400; t++) {
          stepWorld(w, [t < mac.length ? mac[t] : 0, 0]);
          if (f.move) {
            seenMoves.add(f.move);
            const name = pickFrame(j.art, f, w.defs[id]);
            if (!name || !atlas.frames[name]) bad.push(cmd + '/' + f.move + '#' + f.mf + ':' + name);
          }
        }
      }
    }
    ok(bad.length === 0, id + ' 實戰跑完所有必殺技:每格都選得到圖集畫格(' + [...seenMoves].filter((m) => /^sp_|^ult/.test(m)).join(',') + ')' + (bad.length ? '  缺:' + [...new Set(bad)].slice(0, 6).join(', ') : ''));
  }
}

// ---- art.fx 擴充(D19:dy / to / 多組特效)畫面測試 ----
const BASE = 'http://test/data/';
setArtIO(
  {
    async json(url) {
      return JSON.parse(readFileSync(join(root, 'data', url.slice(BASE.length)), 'utf8'));
    },
    async image() {
      return { fake: 'img' };
    }
  },
  BASE
);
function mkCtx() {
  const calls = [];
  const rec = (n) => (...a) => calls.push([n, ...a]);
  const c = { calls };
  for (const n of ['save', 'restore', 'translate', 'scale', 'drawImage', 'fillRect', 'beginPath', 'arc', 'fill', 'rotate', 'moveTo', 'lineTo', 'stroke']) c[n] = rec(n);
  return c;
}
const defOf = (id) => compileChar(JSON.parse(readFileSync(join(root, 'data/chars/' + id + '.json'), 'utf8')));
const fighter = (charId, move, mf) => ({ charId, state: 0, st: 0, vy: 0, stunT: 0, face: 1, move, mf, hf: 0, mt: 0, mtot: 40 });
async function fxCalls(charId, move, mf, face = 1) {
  const def = defOf(charId);
  const f = fighter(charId, move, mf);
  drawFighter(mkCtx(), f, def, 0, 0, 1, false); // 觸發載入
  await new Promise((r) => setTimeout(r, 20));
  const ctx = mkCtx();
  drawMoveFx(ctx, f, def, 100, 100, face, false);
  return ctx.calls;
}
const imgs = (c) => c.filter((x) => x[0] === 'drawImage').length;
{
  let c = await fxCalls('lubu', 'ultimate', 0);
  ok(imgs(c) === 0, 'fx from:第 0 格(蓄力)不畫旋風環');
  c = await fxCalls('lubu', 'ultimate', 5);
  ok(imgs(c) === 1, 'fx 範圍內畫 1 張旋風環');
  ok(c.some((x) => x[0] === 'translate' && x[1] === 100 && x[2] === 66), 'fx dy:往上位移 34 px(y 100 → 66)');
  c = await fxCalls('lubu', 'ultimate', 13);
  ok(imgs(c) === 0, 'fx to:超過結束格(收招)不畫');
  c = await fxCalls('magnet', 'sp_up_atk', 1);
  ok(imgs(c) === 1, '多組特效:第 1 格只畫橫鞭');
  c = await fxCalls('magnet', 'sp_up_atk', 2);
  ok(imgs(c) === 1, '多組特效:第 2 格只畫上撩');
  c = await fxCalls('magnet', 'sp_up_atk', 3);
  ok(imgs(c) === 0, '多組特效:收招格都不畫');
  c = await fxCalls('fanfan', 'sp_up_atk', 1);
  ok(imgs(c) === 1, '舊格式(單一物件、無 to)仍然畫到招式結束');
  {
    const def = defOf('lubu');
    const f = fighter('lubu', 'ultimate', 5);
    f.hf = -1;
    f.hitstop = 3;
    drawFighter(mkCtx(), f, def, 0, 0, 1, false);
    const ctx = mkCtx();
    drawMoveFx(ctx, f, def, 100, 100, 1, false);
    ok(imgs(ctx.calls) === 1, '命中停頓(hf = -1、hitstop > 0)時特效照畫');
    f.hitstop = 0;
    const ctx2 = mkCtx();
    drawMoveFx(ctx2, f, def, 100, 100, 1, false);
    ok(imgs(ctx2.calls) === 0, '沒在出招格也沒停頓(hf = -1)不畫');
  }
  c = await fxCalls('fanfan', 'sp_up_atk', 2);
  ok(imgs(c) === 1, '舊格式:沒設 to 時結束格仍畫');
}
// E2:射彈圖 scale(籠卷大龍捲沿用小龍捲圖放大)、fx sx(只橫向拉長)
{
  await fxCalls('longjuan', 'ultimate', 0); // 觸發載入
  const dw = (ctx) => ctx.calls.find((x) => x[0] === 'drawImage');
  const projW = (kind) => {
    const ctx = mkCtx();
    ok(drawProjectileArt(ctx, 'longjuan', kind, 0, 100, 100, 1), '射彈圖 ' + kind + ' 畫得出來');
    return dw(ctx);
  };
  const small = projW('tornado');
  const big = projW('tornado_big');
  ok(small && big && Math.abs(big[8] / small[8] - 1.45) < 0.01 && Math.abs(big[9] / small[9] - 1.45) < 0.01, 'E2:大龍捲射彈圖 = 小龍捲圖 × 1.45(寬高同比)');
  await fxCalls('qiyu', 'ultimate', 1); // 觸發載入
  const ctx1 = mkCtx();
  drawMoveFx(ctx1, fighter('qiyu', 'ultimate', 1), defOf('qiyu'), 100, 100, 1, true); // 衝擊波畫在角色底下(under)
  const d1 = dw(ctx1);
  ok(d1 && d1[8] > d1[9] * 6, 'fx sx:騎玉衝擊波橫向拉長(寬 / 高 > 6,實際約 ' + (d1 ? Math.round(d1[8]) + '×' + Math.round(d1[9]) : '?') + ' px)');
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
