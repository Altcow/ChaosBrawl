// 無頭模擬測試:node tools/sim-test.mjs
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createWorld, stepWorld, serializeWorld, restoreWorld, hashWorld } from '../js/sim/world.js';
import { BIT } from '../js/core/input.js';
import { S, isInvuln, RULES } from '../js/sim/fighter.js';
import { Rng } from '../js/core/rng.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ada = JSON.parse(readFileSync(join(root, 'tools/fixtures/chars/ada.json'), 'utf8'));

let pass = 0;
let fail = 0;
function check(name, ok, info) {
  if (ok) pass++;
  else fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? '  (' + info + ')' : ''));
}
const mk = (spawns, seed = 1) => createWorld({ chars: { ada }, seed, stage: { w: 1600, d: 240 }, spawns });
const P = (x, z, kind = 'human', extra = {}) => Object.assign({ charId: 'ada', kind, x, z, face: 1 }, extra);

// 1. A-A-A 第三段必倒
{
  const w = mk([P(400, 100), P(436, 100, 'post')]);
  const dm = w.fighters[1];
  let prevA = false;
  let knockTick = -1;
  const hits = [];
  for (let t = 0; t < 120; t++) {
    const p = w.fighters[0];
    const m = p.move ? w.defs.ada.moves[p.move] : null;
    const want = p.state === S.IDLE || (p.state === S.ATTACK && m && m.total - p.mtot <= m.cancel && m.next);
    const press = want && !prevA;
    prevA = press;
    stepWorld(w, [press ? BIT.ATK : 0]);
    for (const e of w.events) if (e.t === 'hit') hits.push(t);
    if (dm.state === S.FALL && knockTick < 0) knockTick = t;
    if (hits.length >= 3 && t > 90) break;
  }
  check('A-A-A 第三段擊倒', hits.length >= 3 && knockTick >= 0, 'hits at ticks ' + hits.slice(0, 3).join(',') + ' fall at ' + knockTick);
  check('前兩段未擊倒(受擊硬直)', hits.length >= 3);
}

// 2. 連防輕攻擊破防(輕 bdef 15)
{
  const w = mk([P(400, 100), P(430, 100, 'puncher', { face: -1, period: 30 })]);
  const d = w.fighters[0];
  d.ai = d.ai;
  let blocks = 0;
  let stunAt = -1;
  for (let t = 0; t < 600 && stunAt < 0; t++) {
    stepWorld(w, [BIT.DEF]);
    for (const e of w.events) if (e.t === 'block') blocks++;
    if (d.state === S.STUN) stunAt = blocks;
  }
  check('連防輕攻擊最終破防暈眩', stunAt > 0, 'broken on block #' + stunAt + ' (6 blocks = 90 bdef, 7 = 105)');
  check('連防 6 下破防(驗收字面)', stunAt === 6, 'actual: ' + stunAt);
}

// 3. 翻滾穿過攻擊(對照組:不翻滾會被打)
{
  function run(roll) {
    const w = mk([P(400, 100), P(430, 100, 'puncher', { face: -1, period: 2 })]);
    const d = w.fighters[0];
    const hp0 = d.hp;
    let hurt = false;
    for (let t = 0; t < 12; t++) {
      stepWorld(w, [roll && t === 0 ? BIT.DEF | BIT.RIGHT : roll ? BIT.DEF | BIT.RIGHT : 0]);
      for (const e of w.events) if (e.t === 'hit' || e.t === 'block') hurt = true;
    }
    return { hurt, hp: d.hp === hp0 };
  }
  const ctrl = run(false);
  const rolled = run(true);
  check('對照組(不翻滾)被打中', ctrl.hurt);
  check('翻滾期間攻擊不命中', !rolled.hurt && rolled.hp);
}

// 4. 倒地 63 tick 打不到
{
  const w = mk([P(400, 100), P(430, 100, 'post')]);
  const dm = w.fighters[1];
  dm.state = S.LYING;
  dm.st = 0;
  const hp0 = dm.hp;
  let prevA = false;
  let firstHitTick = -1;
  for (let t = 0; t < 120; t++) {
    const p = w.fighters[0];
    const press = (p.state === S.IDLE) && !prevA;
    prevA = press;
    p.face = 1;
    stepWorld(w, [press ? BIT.ATK : 0]);
    if (firstHitTick < 0 && w.events.some((e) => e.t === 'hit')) firstHitTick = t;
  }
  check('倒地+起身 63 tick 無法被打', firstHitTick >= 63 && dm.hp < hp0, 'first hit tick ' + firstHitTick + ' (lying 45 + getup 18 = 63)');
}

{
  const w = mk([P(400, 100, 'post')]);
  const dm = w.fighters[0];
  dm.state = S.LYING;
  dm.st = 0;
  let inv = 0;
  for (let t = 0; t < 100; t++) {
    stepWorld(w, [0]);
    if (isInvuln(dm, w.defs.ada)) inv++;
  }
  check('倒地+起身無敵總長 = 63 tick', inv === 63, 'invulnerable ticks = ' + inv);
}

// 5. 防→攻 指令 10 次(三種輸入順序)
{
  const seqs = {
    '依序 D,→,A': (k) => [BIT.DEF, BIT.DEF | BIT.RIGHT, BIT.DEF | BIT.RIGHT, BIT.DEF | BIT.RIGHT | BIT.ATK][k] || 0,
    '同時 D+→ 後 A': (k) => (k < 4 ? BIT.DEF | BIT.RIGHT : k === 4 ? BIT.DEF | BIT.RIGHT | BIT.ATK : BIT.DEF | BIT.RIGHT),
    '先 → 再 D 再 A': (k) => (k < 2 ? BIT.RIGHT : k < 4 ? BIT.RIGHT | BIT.DEF : BIT.RIGHT | BIT.DEF | BIT.ATK)
  };
  for (const name in seqs) {
    let ok = 0;
    for (let n = 0; n < 10; n++) {
      const w = mk([P(400, 100)]);
      const f = w.fighters[0];
      f.mp = 200 * 256;
      let got = false;
      for (let k = 0; k < 40; k++) {
        const b = k < 6 ? (typeof seqs[name](k) === 'number' ? seqs[name](k) : 0) : 0;
        stepWorld(w, [b]);
        if (f.move === 'sp_fwd_atk' || w.projectiles.length) got = true;
      }
      if (got) ok++;
    }
    check('防→攻 ' + name + ' 10 次成功 ≥ 9', ok >= 9, ok + '/10');
  }
}

// 6. 其他狀態與數值
{
  // 取消跳躍(預設):單獨按跳(K / A / 觸控)不起跳(K 單按 = 前衝月步);RULES.noJump = false 時舊跳躍仍可用(舊行為比對)
  const jumpTest = () => {
    const w = mk([P(400, 100)]);
    const f = w.fighters[0];
    let t = 0;
    stepWorld(w, [BIT.JUMP]); t++;
    let air = 0;
    let maxY = 0;
    for (; t < 80; t++) {
      stepWorld(w, [0]);
      if (f.y > 0) air++;
      maxY = Math.max(maxY, f.y >> 8);
    }
    return { air, maxY, f };
  };
  const nj = jumpTest();
  check('取消跳躍:單獨按跳不離地(全程 y = 0),且觸發月步前衝', nj.air === 0 && nj.maxY === 0, 'air=' + nj.air + ' maxY=' + nj.maxY);
  RULES.noJump = false;
  const legacy = jumpTest();
  RULES.noJump = true;
  check('舊規則(RULES.noJump = false):跳滯空約 36 tick、最高約 81 px', legacy.air >= 33 && legacy.air <= 38 && legacy.maxY >= 78 && legacy.maxY <= 90, 'air=' + legacy.air + ' maxY=' + legacy.maxY);
}
{
  const w = mk([P(400, 100)]);
  const f = w.fighters[0];
  stepWorld(w, [BIT.RIGHT]);
  stepWorld(w, [0]);
  stepWorld(w, [BIT.RIGHT]);
  check('連按同向兩次進入跑', f.state === S.RUN, 'state=' + f.state);
  for (let i = 0; i < 5; i++) stepWorld(w, [BIT.RIGHT]);
  stepWorld(w, [BIT.LEFT]);
  check('跑中反方向 = 急停', f.state === S.RUNSTOP, 'state=' + f.state);
}

// 7. 決定性 + 序列化還原
{
  function scenario(seed) {
    const w = mk([P(300, 100), P(700, 120, 'puncher', { face: -1 }), P(500, 60, 'post')], seed);
    const r = new Rng(seed);
    const inputs = [];
    let cur = 0;
    for (let t = 0; t < 10800; t++) {
      if (t % 12 === 0) cur = r.next() & 127;
      inputs.push(cur);
    }
    return { w, inputs };
  }
  const run = (s, from, to, w0) => {
    const w = w0 || s.w;
    const hashes = [];
    for (let t = from; t < to; t++) {
      stepWorld(w, [s.inputs[t]]);
      if (t % 60 === 59) hashes.push(hashWorld(w));
    }
    return hashes;
  };
  const a = scenario(7);
  const b = scenario(7);
  const ha = run(a, 0, 10800);
  const hb = run(b, 0, 10800);
  check('同種子同輸入 3 分鐘每秒雜湊一致', JSON.stringify(ha) === JSON.stringify(hb), ha.length + ' hashes');
  // 還原
  const c = scenario(7);
  run(c, 0, 5000);
  const snap = serializeWorld(c.w);
  const d = scenario(7);
  restoreWorld(d.w, snap);
  const hc = run(c, 5000, 10800);
  const hd = run(d, 5000, 10800);
  check('序列化 → 還原後繼續跑結果一致', JSON.stringify(hc) === JSON.stringify(hd));
  const lastA = ha[ha.length - 1];
  check('還原結果與不中斷版一致', hd[hd.length - 1] === lastA);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
