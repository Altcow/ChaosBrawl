// M2 無頭對戰測試:node tools/match-test.mjs [quick]
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createWorld, stepWorld, serializeWorld, restoreWorld, hashWorld } from '../js/sim/world.js';
import { layoutSpawns } from '../js/sim/modes.js';
import { LEVELS } from '../js/sim/ai.js';
import { BIT } from '../js/core/input.js';
import { S, takeHit } from '../js/sim/fighter.js';
import { Rng } from '../js/core/rng.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const ids = JSON.parse(readFileSync(join(root, 'data/chars/index.json'), 'utf8'));
const chars = {};
for (const id of ids) chars[id] = JSON.parse(readFileSync(join(root, 'data/chars/' + id + '.json'), 'utf8'));
for (const id of ['ada', 'grandma', 'librarian', 'cat']) chars[id] = JSON.parse(readFileSync(join(root, 'tools/fixtures/chars/' + id + '.json'), 'utf8')); // 舊 4 人僅供測試(不在正式名單)
const stage = JSON.parse(readFileSync(join(root, 'data/stages/market.json'), 'utf8'));

let pass = 0;
let fail = 0;
function check(name, ok, info) {
  if (ok) pass++;
  else fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (info ? '  (' + info + ')' : ''));
}

export function makeMatch(players, seed, mode = 'brawl') {
  const lay = layoutSpawns(players.length, stage);
  const spawns = players.map((p, i) => ({ charId: p.char, kind: p.kind || 'ai', lvl: p.lvl || 0, x: lay[i].x, z: lay[i].z, face: lay[i].face }));
  return createWorld({ chars, seed, stage, spawns, mode });
}
function runUntilOver(w, max = 20000, inputs = () => []) {
  for (let t = 0; t < max && !w.mode.over; t++) stepWorld(w, inputs(t));
  return w.mode.winner;
}

const quick = process.argv[2] === 'quick';
const N = quick ? 4 : 10;

// 1. 困難 vs 新手 1v1(同角色),10 場勝 ≥ 8
{
  let hardWins = 0;
  const detail = [];
  for (const ch of ['ada']) {
    for (let i = 0; i < N; i++) {
      const hardFirst = i % 2 === 0;
      const players = hardFirst ? [{ char: ch, lvl: 2 }, { char: ch, lvl: 0 }] : [{ char: ch, lvl: 0 }, { char: ch, lvl: 2 }];
      const w = makeMatch(players, 100 + i);
      const win = runUntilOver(w);
      const hardId = hardFirst ? 0 : 1;
      if (win === hardId) hardWins++;
      detail.push(win === hardId ? 'H' : win < 0 ? '-' : 'N');
    }
  }
  check('困難 vs 新手 ' + N + ' 場勝 ≥ ' + Math.ceil(N * 0.8), hardWins >= Math.ceil(N * 0.8), hardWins + '/' + N + ' ' + detail.join(''));
}

// 2. 互剋傾向(4 角色,困難 vs 困難,10 場,左右對調)
{
  const pairs = [['grandma', 'cat'], ['librarian', 'grandma'], ['cat', 'librarian'], ['ada', 'grandma'], ['ada', 'cat'], ['ada', 'librarian']];
  for (const [a, b] of pairs) {
    let aw = 0;
    let bw = 0;
    for (let i = 0; i < N; i++) {
      const aFirst = i % 2 === 0;
      const players = aFirst ? [{ char: a, lvl: 2 }, { char: b, lvl: 2 }] : [{ char: b, lvl: 2 }, { char: a, lvl: 2 }];
      const w = makeMatch(players, 200 + i);
      const win = runUntilOver(w);
      if (win < 0) continue;
      const aId = aFirst ? 0 : 1;
      if (win === aId) aw++;
      else bw++;
    }
    console.log('INFO 互剋 ' + a + ' vs ' + b + ': ' + aw + ' - ' + bw + (aw === bw ? ' (無傾向)' : aw > bw ? ' (' + a + ' 佔優)' : ' (' + b + ' 佔優)'));
  }
}

// 3. 8 人同場決定性:同種子同輸入 3 分鐘(含真人輸入)每秒雜湊一致;序列化還原一致
{
  const mk = () => {
    const players = [{ kind: 'human', char: 'ada' }];
    for (let i = 1; i < 8; i++) players.push({ char: ids[i % 4], lvl: i % 4 });
    return makeMatch(players, 7, 'timed');
  };
  const r = new Rng(5);
  const inp = [];
  let cur = 0;
  for (let t = 0; t < 10800; t++) {
    if (t % 12 === 0) cur = r.next() & 127;
    inp.push([cur]);
  }
  const run = (w, a, b) => {
    const hs = [];
    for (let t = a; t < b; t++) {
      stepWorld(w, inp[t]);
      if (t % 60 === 59) hs.push(hashWorld(w));
    }
    return hs;
  };
  const t0 = Date.now();
  const w1 = mk();
  const h1 = run(w1, 0, 10800);
  const ms = Date.now() - t0;
  const h2 = run(mk(), 0, 10800);
  check('8 人 3 分鐘同種子同輸入雜湊一致', JSON.stringify(h1) === JSON.stringify(h2), h1.length + ' hashes; sim ' + ms + ' ms for 10800 ticks (' + (ms / 10800).toFixed(3) + ' ms/tick)');
  const wa = mk();
  run(wa, 0, 5000);
  const snap = serializeWorld(wa);
  const wb = mk();
  restoreWorld(wb, snap);
  const ha = run(wa, 5000, 10800);
  const hb = run(wb, 5000, 10800);
  check('8 人局序列化還原後續跑一致', JSON.stringify(ha) === JSON.stringify(hb));
  check('時間賽 3 分鐘有擊殺產生', w1.fighters.reduce((s, f) => s + f.kills, 0) > 0, 'kills=' + w1.fighters.map((f) => f.kills).join(','));
}

// 4. 大亂鬥:8 人 AI 打完(單命、最後存活者或 5 分鐘 HP%)
{
  const players = [];
  for (let i = 0; i < 8; i++) players.push({ char: ids[i % 4], lvl: 1 + (i % 3) });
  const w = makeMatch(players, 11);
  const win = runUntilOver(w, 20000);
  check('大亂鬥 8 人可正常結算', w.mode.over, 'winner=' + win + ' tick=' + w.tick + ' alive=' + w.fighters.filter((f) => !f.dead).length);
}

// 5. 時間賽:重生與同分加賽
{
  const w = makeMatch([{ char: 'ada', lvl: 2 }, { char: 'cat', lvl: 2 }], 3, 'timed');
  let respawned = false;
  let wasDead = false;
  for (let t = 0; t < 10800 + 1800 + 5 && !w.mode.over; t++) {
    stepWorld(w, []);
    for (const f of w.fighters) {
      if (f.dead) wasDead = true;
      else if (wasDead && f.inv > 0) respawned = true;
    }
  }
  check('時間賽死亡後重生且有 2 秒無敵', respawned);
  check('時間賽到時結算', w.mode.over, 'tick=' + w.tick + ' kills=' + w.fighters.map((f) => f.kills).join(',') + ' winner=' + w.mode.winner + ' overtime=' + w.mode.overtime);
}

// 6. 角色特殊機制單元測試
function duel(a, b, bKind = 'post') {
  const spawns = [
    { charId: a, kind: 'human', x: 400, z: 100, face: 1 },
    { charId: b, kind: bKind, x: 436, z: 100, face: -1 }
  ];
  return createWorld({ chars, seed: 1, stage, spawns, mode: 'practice' });
}
const cmd = (w, bytes) => { for (const b of bytes) stepWorld(w, [b]); };
const FWD = [BIT.DEF | BIT.RIGHT, BIT.DEF | BIT.RIGHT, BIT.DEF | BIT.RIGHT | BIT.ATK, 0];
{
  // 阿嬤霸體:普攻中被輕攻擊(fall < 35)不進受擊硬直,仍扣血;重擊照樣打斷
  const w = duel('grandma', 'ada');
  const g = w.fighters[0];
  cmd(w, [BIT.ATK]);
  const hp0 = g.hp;
  const light = w.defs.ada.moves.attack1.frames[1].itr[0];
  const r1 = takeHit(w, g, g.x + 20 * 256, light, 1, false);
  const keep = g.state === S.ATTACK;
  g.hitstop = 0;
  const heavy = w.defs.ada.moves.attack3.frames[1].itr[0];
  takeHit(w, g, g.x + 20 * 256, heavy, 1, false);
  check('阿嬤普攻霸體:輕攻擊不打斷(仍扣血)', r1 === 'hit' && keep && g.hp < hp0, 'state kept=' + keep + ' hp ' + (hp0 >> 8) + '->' + (g.hp >> 8));
  check('阿嬤霸體不擋 fall 60 以上重擊', g.state === S.HURT || g.state === S.FALL, 'state=' + g.state);
}
{
  const w = duel('grandma', 'ada');
  cmd(w, [BIT.DEF | BIT.RIGHT, BIT.DEF | BIT.RIGHT, BIT.DEF | BIT.RIGHT | BIT.ATK]);
  const d = w.fighters[1];
  d.state = S.DEFEND; // 對手舉盾
  d.face = -1;
  let r = '';
  for (let t = 0; t < 40; t++) {
    stepWorld(w, [0]);
    d.state = d.state === S.FALL || d.state === S.LYING ? d.state : S.DEFEND;
    for (const e of w.events) r += e.t + ',';
  }
  check('阿嬤菜籃摔(grab)不能防', /hit/.test(r) && !/block/.test(r), r);
}
{
  const w = duel('cat', 'ada');
  const c = w.fighters[0];
  cmd(w, [BIT.DEF | BIT.RIGHT, BIT.DEF | BIT.RIGHT, BIT.DEF | BIT.RIGHT | BIT.JUMP]);
  const behind = w.fighters[1].x > c.x;
  check('喵影影步瞬移到對手背後', c.x > w.fighters[1].x - 1 && c.face === -1, 'cat.x=' + (c.x >> 8) + ' target.x=' + (w.fighters[1].x >> 8) + ' face=' + c.face + (behind ? '' : ' (behind ok)'));
}
{
  const w = duel('cat', 'ada', 'puncher');
  w.fighters[1].ai.cd = 20;
  cmd(w, [BIT.DEF | BIT.DOWN, BIT.DEF | BIT.DOWN, BIT.DEF | BIT.DOWN | BIT.JUMP]);
  let counter = false;
  let dmg = false;
  for (let t = 0; t < 60; t++) {
    stepWorld(w, [0]);
    for (const e of w.events) {
      if (e.t === 'counter') counter = true;
      if (e.t === 'hit') dmg = true;
    }
  }
  check('喵影裝死:被近戰碰到就反擊', counter && dmg && w.fighters[0].hp === w.defs.cat.hp, 'counter=' + counter + ' enemyHit=' + dmg);
}
{
  const w = duel('librarian', 'ada');
  cmd(w, [BIT.DEF | BIT.RIGHT, BIT.DEF | BIT.RIGHT, BIT.DEF | BIT.RIGHT | BIT.ATK]);
  w.fighters[1].x = 1500 * 256;
  cmd(w, new Array(12).fill(0));
  const zs = w.projectiles.map((p) => p.vz).sort((a, b) => a - b);
  check('館長飛書三連:z 軸扇形 3 發', zs.length === 3 && zs[0] < 0 && zs[1] === 0 && zs[2] > 0, 'vz=' + zs.join(','));
}
{
  // 館長放書牆,阿達從對面丟便當 → 被牆擋掉
  const w = createWorld({ chars, seed: 1, stage, mode: 'practice', spawns: [
    { charId: 'librarian', kind: 'human', x: 400, z: 100, face: 1 },
    { charId: 'ada', kind: 'human', x: 700, z: 100, face: -1 }] });
  for (const b of [BIT.DEF | BIT.UP, BIT.DEF | BIT.UP, BIT.DEF | BIT.UP | BIT.ATK, 0]) stepWorld(w, [b, 0]);
  for (let t = 0; t < 20; t++) stepWorld(w, [0, 0]);
  const wall = w.projectiles.some((p) => p.kind === 'bookwall');
  for (const b of [BIT.DEF | BIT.LEFT, BIT.DEF | BIT.LEFT, BIT.DEF | BIT.LEFT | BIT.ATK, 0]) stepWorld(w, [0, b]);
  let thrown = false;
  let hit = false;
  for (let t = 0; t < 120; t++) {
    stepWorld(w, [0, 0]);
    if (w.projectiles.some((p) => p.kind === 'bento')) thrown = true;
    if (w.events.some((e) => e.t === 'hit')) hit = true;
  }
  check('館長書牆擋射彈(便當被擋下)', wall && thrown && !hit && w.fighters[0].hp === w.defs.librarian.hp, 'wall=' + wall + ' thrown=' + thrown + ' hit=' + hit);
}
{
  const w = createWorld({ chars, seed: 1, stage, mode: 'practice', spawns: [
    { charId: 'librarian', kind: 'human', x: 400, z: 100, face: 1 },
    { charId: 'ada', kind: 'human', x: 450, z: 100, face: -1 }] });
  w.fighters[0].mp = 500 * 256;
  for (const b of [BIT.DEF | BIT.DOWN, BIT.DEF | BIT.DOWN, BIT.DEF | BIT.DOWN | BIT.ATK, 0]) stepWorld(w, [b, 0]);
  for (let t = 0; t < 20; t++) stepWorld(w, [0, 0]);
  w.fighters[1].mp = 500 * 256;
  const f = w.fighters[1];
  const before = f.mp;
  for (const b of FWD) stepWorld(w, [0, b]);
  check('館長安靜圈:圈內不能放必殺', f.move !== 'sp_fwd_atk' && f.silence > 0, 'silence=' + f.silence + ' move=' + f.move);
}
{
  const w = duel('grandma', 'ada');
  w.fighters[0].mp = 500 * 256;
  cmd(w, [BIT.DEF | BIT.UP, BIT.DEF | BIT.UP, BIT.DEF | BIT.UP | BIT.JUMP]);
  let maxY = 0;
  let ok = false;
  for (let t = 0; t < 60; t++) {
    stepWorld(w, [0]);
    maxY = Math.max(maxY, w.fighters[0].y >> 8);
    if (w.events.some((e) => e.t === 'hit')) ok = true;
  }
  check('阿嬤大跳壓:跳起並壓中', maxY > 50 && ok, 'maxY=' + maxY + ' hit=' + ok);
}
{
  const w = duel('grandma', 'ada');
  w.fighters[0].mp = 500 * 256;
  cmd(w, [BIT.DEF | BIT.DOWN, BIT.DEF | BIT.DOWN, BIT.DEF | BIT.DOWN | BIT.ATK]);
  let ok = false;
  for (let t = 0; t < 50; t++) {
    stepWorld(w, [0]);
    if (w.events.some((e) => e.t === 'hit')) ok = true;
  }
  check('阿嬤廣場舞震地命中周圍', ok && w.fighters[1].state !== S.IDLE);
}
{
  const levels = LEVELS.map((l) => l.delay);
  check('AI 反應延遲 tick 對應 400/250/150/80 ms', JSON.stringify(levels) === '[24,15,9,5]', levels.join('/'));
  // 同一真人最多被 2 個 AI 鎖定(新手/普通)
  const players = [{ kind: 'human', char: 'ada' }];
  for (let i = 0; i < 5; i++) players.push({ char: 'ada', lvl: i % 2 });
  const w = makeMatch(players, 9, 'brawl');
  let maxLock = 0;
  for (let t = 0; t < 1800; t++) {
    stepWorld(w, [0]);
    const n = w.fighters.filter((f) => f.kind === 'ai' && f.ai.lvl <= 1 && f.ai.tgt === 0 && !f.dead).length;
    if (n > maxLock) maxLock = n;
  }
  check('同一真人最多被 2 個 AI(新手/普通)鎖定', maxLock <= 2, 'max=' + maxLock);
}


// ---------- M4:分隊與友軍傷害 ----------
{
  const mkTeam = (ff, a = 'ada', b = 'librarian') => createWorld({ chars, seed: 1, stage, mode: 'brawl', ff, spawns: [
    { charId: a, kind: 'human', team: 0, x: 400, z: 100, face: 1 },
    { charId: b, kind: 'human', team: 0, x: 436, z: 100, face: -1 }] });
  const runMelee = (ff) => {
    const w = mkTeam(ff, 'ada', 'ada');
    let hit = false;
    for (let t = 0; t < 40; t++) {
      stepWorld(w, [t % 20 === 0 ? BIT.ATK : 0, 0]);
      if (w.events.some((e) => e.t === 'hit')) hit = true;
    }
    return hit;
  };
  check('友軍傷害 關:同隊近戰穿過', runMelee(0) === false);
  check('友軍傷害 部分:同隊近戰仍穿過', runMelee(1) === false);
  check('友軍傷害 全開:同隊近戰命中', runMelee(2) === true);
  const runProj = (ff) => {
    const w = createWorld({ chars, seed: 1, stage, mode: 'brawl', ff, spawns: [
      { charId: 'ada', kind: 'human', team: 0, x: 300, z: 100, face: 1 },
      { charId: 'ada', kind: 'human', team: 0, x: 500, z: 100, face: -1 },
      { charId: 'ada', kind: 'post', team: 1, x: 1500, z: 100, face: -1 }] });
    w.fighters[0].mp = 500 * 256;
    let hit = false;
    for (let t = 0; t < 90; t++) {
      stepWorld(w, [t === 0 ? BIT.DEF | BIT.RIGHT : t === 1 ? BIT.DEF | BIT.RIGHT : t === 2 ? BIT.DEF | BIT.RIGHT | BIT.ATK : 0, 0, 0]);
      if (w.events.some((e) => e.t === 'hit' && e.d === 1)) hit = true;
    }
    return hit;
  };
  check('友軍傷害 關:同隊射彈穿過', runProj(0) === false);
  check('友軍傷害 部分:同隊射彈命中', runProj(1) === true);
  check('友軍傷害 全開:同隊射彈命中', runProj(2) === true);
  // 分隊戰:最後存活的隊伍獲勝;AI 不攻擊隊友
  const lay = layoutSpawns(6, stage);
  const players = [0, 1, 2, 3, 4, 5].map((i) => ({ charId: ids[i % 4], kind: 'ai', lvl: 2, team: i % 2, x: lay[i].x, z: lay[i].z, face: lay[i].face }));
  const w = createWorld({ chars, seed: 5, stage, mode: 'team', ff: 0, spawns: players });
  let teamKill = false;
  for (let t = 0; t < 20000 && !w.mode.over; t++) {
    stepWorld(w, []);
    for (const e of w.events) if (e.t === 'hit' && w.fighters[e.a].team === w.fighters[e.d].team) teamKill = true;
  }
  const aliveTeams = new Set(w.fighters.filter((f) => !f.dead).map((f) => f.team));
  check('分隊戰 3v3 可結算,獲勝隊伍為唯一存活隊伍(或時間到 HP% 最高)', w.mode.over && w.mode.winner >= 0, 'winner=team ' + w.mode.winner + ' tick=' + w.tick + ' aliveTeams=' + [...aliveTeams].join(','));
  check('分隊戰(友軍傷害關):無任何友軍命中', !teamKill);
  // AI 不鎖定隊友
  let lockedAlly = false;
  const w2 = createWorld({ chars, seed: 6, stage, mode: 'team', ff: 0, spawns: players });
  for (let t = 0; t < 1800; t++) {
    stepWorld(w2, []);
    for (const f of w2.fighters) if (f.ai.tgt >= 0 && w2.fighters[f.ai.tgt].team === f.team) lockedAlly = true;
  }
  check('AI 不把隊友當目標', !lockedAlly);
}

console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
