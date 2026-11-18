// 手機滑動出招設計 第 7 節(普攻降傷 / MP 經濟)平衡驗證:
//   node tools/balance-test.mjs              靜態資料斷言 + 小樣本 TTK 模擬(預設每格 6 場)
//   node tools/balance-test.mjs 40           對 AI 場景每格 40 場(樣本數不設上限;木樁完全確定性只跑 1 場)
//   CHARS_DIR=<舊資料夾> EMU_DECAY=0 node tools/balance-test.mjs 40 report   用舊資料基準對照(report 不判定)
//   node tools/balance-test.mjs 40 report    只印完整統計表(不判定過失敗)
// 模擬:腳本機器人(human 座位 0)用三種打法打 500 血目標,量「殺死所需秒數」:
//   basic = 只用普攻連段;special = 只用必殺 + 最強;mixed = 有 MP 放招、爆氣滿放最強、其餘普攻
//   場景 post = 靜止木樁(命中率 100%,下限);ai = 普通級電腦 areh(會閃會擋,命中率貼近實戰),機器人血量灌滿只量輸出
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { createWorld, stepWorld } from '../js/sim/world.js';
import { BIT } from '../js/core/input.js';
import { S } from '../js/sim/fighter.js';
import { RAGE_MAX, ULT_MACRO, ULT_CAP } from '../js/sim/ult.js';
import { commandMacro } from '../js/sim/command.js';
import { FX, px } from '../js/core/fixed.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const CHAR_DIR = process.env.CHARS_DIR || join(root, 'data/chars'); // 可指向舊版資料夾跑基準對照
const ids = JSON.parse(readFileSync(join(CHAR_DIR, 'index.json'), 'utf8'));
const chars = {};
for (const id of ids) chars[id] = JSON.parse(readFileSync(join(CHAR_DIR, id + '.json'), 'utf8'));
chars.dummy = Object.assign(JSON.parse(JSON.stringify(JSON.parse(readFileSync(join(root, 'tools/fixtures/chars/ada.json'), 'utf8')))), { id: 'dummy', hp: 500 });

const N = Number(process.argv[2]) || 6;
const REPORT = process.argv[3] === 'report';
let pass = 0;
let fail = 0;
function check(name, ok, info) {
  if (REPORT) return;
  if (ok) pass++;
  else fail++;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (info !== undefined ? '  (' + info + ')' : ''));
}

// ---------- 1. 靜態資料斷言 ----------
const BASIC = ['attack1', 'attack2', 'attack3', 'runatk', 'jumpatk', 'dashatk'];
const COSTS = [55, 70, 90, 105, 125];
const hits = (m) => {
  const a = [];
  for (const f of m.frames || []) if (f.itr) a.push(...[].concat(f.itr));
  return a;
};
const stat = {};
for (const id of ids) {
  const j = chars[id];
  const combo = ['attack1', 'attack2', 'attack3'].reduce((s, m) => s + hits(j.moves[m])[0].dmg, 0);
  const basicHits = BASIC.flatMap((m) => hits(j.moves[m]).map((i) => i.dmg));
  const avg = basicHits.reduce((a, b) => a + b, 0) / basicHits.length;
  stat[id] = { combo, pct: (combo / j.hp) * 100, max: Math.max(...basicHits), avg };
  check(id + ' 普攻整套連段占血量 6.7%~9.3%(' + combo + '/' + j.hp + ')', stat[id].pct >= 6.65 && stat[id].pct <= 9.35, stat[id].pct.toFixed(2) + '%');
  check(id + ' 普攻單下 ≤ 16 且不超過普攻平均 1.5 倍', stat[id].max <= 16 && stat[id].max <= avg * 1.5, 'max=' + stat[id].max + ' avg=' + avg.toFixed(1));
  check(id + ' 普攻類招式皆有 basic 旗標(招式與 itr),且普攻不回 MP(gain 0)', BASIC.every((m) => j.moves[m].basic === true && hits(j.moves[m]).every((i) => i.basic === true && !i.gain)));
  check(id + ' 普攻 bdef ≤ 18(×0.5)', BASIC.every((m) => hits(j.moves[m]).every((i) => i.bdef <= 18)));
  const sp = Object.entries(j.moves).filter(([n, m]) => m.cost > 0 && /^sp_/.test(n));
  check(id + ' 必殺 MP 消耗皆在 55/70/90/105/125', sp.length >= 3 && sp.every(([, m]) => COSTS.includes(m.cost)), sp.map(([, m]) => m.cost).join('/'));
  check(id + ' mp 500 / mpStart 300 / mpRegen 14', j.mp === 500 && j.mpStart === 300 && j.mpRegen === 14);
  const u = j.moves.ultimate.ult;
  const typeCap = ULT_CAP[u.type] !== undefined ? ULT_CAP[u.type] : ULT_CAP.dodge;
  check(id + ' 最強每目標上限 cap ≤ 類型上限 ' + typeCap, u.cap === undefined || u.cap <= typeCap, 'cap=' + u.cap);
}
check('漫漫龜跑攻 = 16(對齊基準 40 × 0.4)', chars.manman.moves.runatk.frames.some((f) => f.itr && [].concat(f.itr)[0].dmg === 16));

// ---------- 2. 模擬機器人 ----------
const mkWorld = (id, scen, seed) =>
  createWorld({
    chars,
    seed,
    ult: true,
    mode: 'practice',
    stage: { w: 1600, d: 240 },
    spawns: [
      { charId: id, kind: 'human', x: 600, z: 100, face: 1 },
      scen === 'post' ? { charId: 'dummy', kind: 'post', x: 800, z: 100, face: -1 } : { charId: 'areh', kind: 'ai', lvl: 1, x: 800, z: 100, face: -1 }
    ]
  });

function makeBot(id, mode) {
  const j = chars[id];
  // 只挑「會造成傷害」的必殺(回血 / 反擊架式 / 純位移不算;陷阱要踩才中,機器人不會設局故也排除)
  const dmgful = (cmd) => {
    const m = j.moves[cmd];
    if (hits(m).some((i) => i.dmg > 0)) return true;
    return (m.frames || []).some((f) => f.spawn && [].concat(f.spawn).some((sp) => { const p = j.projectiles[sp.proj]; return p && !p.limit && p.itr && [].concat(p.itr).some((i) => i.dmg > 0); }));
  };
  const specs = j.ai.specials.filter((sp) => dmgful(sp.cmd)).sort((a, b) => chars[id].moves[b.cmd].cost - chars[id].moves[a.cmd].cost); // 優先高消耗
  const ultR = j.ai.ult;
  let queue = [];
  let prevAtk = false;
  const bot = { cat: 'basic', cast: 0, back: 0 };
  bot.think = (w) => {
    const f = w.fighters[0];
    const t = w.fighters[1];
    if (queue.length) return queue.shift();
    const cm = w.fighters[0].move ? w.defs[id].moves[w.fighters[0].move] : null;
    if (w.fighters[0].state === S.SPECIAL && cm && cm.steer) {
      // 可操控的招式(星星糖 / 豬突 / 赤兔等):按住方向追著目標
      const sdx = px(w.fighters[1].x - w.fighters[0].x);
      const sdz = px(w.fighters[1].z - w.fighters[0].z);
      return (sdx > 0 ? BIT.RIGHT : BIT.LEFT) | (Math.abs(sdz) > 8 ? (sdz > 0 ? BIT.DOWN : BIT.UP) : 0);
    }
    const dx = px(t.x - f.x);
    const dz = px(t.z - f.z);
    const face = dx >= 0 ? 1 : -1;
    const free = f.state === S.IDLE || f.state === S.WALK || f.state === S.RUN;
    const m = f.move ? w.defs[id].moves[f.move] : null;
    const canChain = f.state === S.ATTACK && m && m.next && m.total - f.mtot <= m.cancel;
    const move = () => {
      let b = 0;
      if (Math.abs(dz) > 6) b |= dz > 0 ? BIT.DOWN : BIT.UP;
      if (Math.abs(dx) > 30) b |= dx > 0 ? BIT.RIGHT : BIT.LEFT;
      return b;
    };
    if (free && Math.abs(dx) < 10 && !bot.back) bot.back = 30; // 貼太近 / 卡牆角:往場中央連走 30 tick 拉開
    if (free && bot.back > 0) {
      bot.back--;
      return f.x > (w.stage.w / 2) * FX ? BIT.LEFT : BIT.RIGHT;
    }
    if (free && f.face !== face) return face > 0 ? BIT.RIGHT : BIT.LEFT; // 先轉向面對目標
    if (free && mode !== 'basic') {
      if (f.rage >= RAGE_MAX && ultR && Math.abs(dx) <= ultR.range && Math.abs(dz) <= (ultR.zr || 130) && !w.ult.cd) {
        queue = ULT_MACRO.slice(1);
        bot.cat = 'ult';
        bot.cast++;
        return ULT_MACRO[0];
      }
      for (const sp of specs) {
        const mv = j.moves[sp.cmd];
        if (f.mp >= mv.cost * FX && Math.abs(dx) >= sp.min && Math.abs(dx) <= sp.max && Math.abs(dz) <= sp.zr + 6) {
          const mac = commandMacro(sp.cmd, f.face);
          queue = mac.slice(1);
          bot.cat = 'special';
          bot.cast++;
          return mac[0];
        }
      }
    }
    if (mode === 'special') {
      // 只放必殺:有錢的最貴一招;不在射程帶就走位(太遠靠近、太近退開),沒 MP 就站著等回復
      if (!free) return 0;
      const cand = specs.find((sp) => f.mp >= j.moves[sp.cmd].cost * FX);
      if (!cand) return 0;
      const ad = Math.abs(dx);
      if (Math.abs(dz) > cand.zr) return dz > 0 ? BIT.DOWN : BIT.UP;
      if (ad > cand.max - 8) return face > 0 ? BIT.RIGHT : BIT.LEFT;
      if (ad < cand.min) return face > 0 ? BIT.LEFT : BIT.RIGHT;
      return 0;
    }
    // 普攻
    if (free || canChain) {
      if (Math.abs(dx) <= 44 && Math.abs(dz) <= 8) {
        const press = !prevAtk;
        prevAtk = press;
        if (press) bot.cat = 'basic';
        return press ? BIT.ATK : 0;
      }
      prevAtk = false;
      return free ? move() : 0;
    }
    prevAtk = false;
    return 0;
  };
  return bot;
}

// 引擎是否已實作「普攻遞減」(devA):量木樁連續被普攻打中的每下傷害,第 7 下起明顯小於第 1 下就是有
function probeDecay() {
  const w = mkWorld('fanfan', 'post', 5);
  const bot = makeBot('fanfan', 'basic');
  const t = w.fighters[1];
  const me = w.fighters[0];
  const drops = [];
  let last = t.hp + t.gray;
  for (let k = 0; k < 900 && drops.length < 8; k++) {
    stepWorld(w, [bot.think(w)]);
    me.hp = w.defs.fanfan.hp;
    const cur = t.hp + t.gray;
    if (cur < last) drops.push(((last - cur) / FX) * (10 / 7));
    last = cur;
  }
  return drops.length >= 7 && drops[6] < drops[0] * 0.6;
}
const ENGINE_DECAY = probeDecay();
const EMU = !ENGINE_DECAY && process.env.EMU_DECAY !== '0'; // 引擎尚無遞減時,在腳本內照文件 7-3 規則模擬(補血 + 補 MP),引擎一旦實作就自動停用

function runOne(id, mode, scen, seed, maxTick = 20000) {
  const w = mkWorld(id, scen, seed);
  const bot = makeBot(id, mode);
  const me = w.fighters[0];
  const t = w.fighters[1];
  me.hp = w.defs[id].hp; // 只量輸出:機器人不死(滿血也使「血少回 MP 加快」不介入)
  const dmgBy = { basic: 0, special: 0, ult: 0 };
  let last = t.hp + t.gray;
  let tk = 0;
  let prevHp = t.hp;
  let nHit = 0;
  let nHitT = -9999;
  const def = w.defs[id];
  for (; tk < maxTick && !(t.dead || t.hp <= 0 || t.state === S.DEAD || t.hp - prevHp > 100 * FX); tk++) {
    prevHp = t.hp;
    stepWorld(w, [bot.think(w)]);
    me.hp = def.hp;
    me.gray = 0;
    let cur = t.hp + t.gray;
    if (cur < last && bot.cat === 'basic' && EMU) {
      // 文件 7-3:同目標 3 秒內第 4~6 下 ×0.5、第 7 下起 ×0.25;只有前 3 下回 MP +4
      if (w.tick - nHitT > 180) nHit = 0;
      nHitT = w.tick;
      nHit++;
      const k = nHit <= 3 ? 1 : nHit <= 6 ? 0.5 : 0.25;
      const refund = ((last - cur) * 10 * (1 - k)) / 7; // 傷害 d:hp 掉 d、灰血 +0.3d(hp+灰血 總掉 0.7d);被遞減的部分兩者都退回
      t.hp += Math.round(refund);
      t.gray = Math.max(0, t.gray - Math.round(refund * 0.3));
      cur = t.hp + t.gray;
      if (nHit <= 3) me.mp = Math.min(def.mp, me.mp + 4 * FX);
    }
    if (cur < last) dmgBy[bot.cat] += ((last - cur) / FX) * (10 / 7);
    last = cur;
  }
  return { ticks: tk, killed: tk < maxTick, dmgBy, cast: bot.cast };
}

const med = (a) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(s.length / 2)]; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const ci = (a) => (a.length > 1 ? 1.96 * Math.sqrt(a.reduce((s, v) => s + (v - mean(a)) ** 2, 0) / (a.length - 1) / a.length) : 0);

const T0 = Date.now();
const table = {};
for (const scen of ['post', 'ai']) {
  for (const mode of ['mixed', 'special', 'basic']) {
    const per = {};
    for (const id of ids) {
      const secs = [];
      let killed = 0;
      let bas = 0;
      let tot = 0;
      const n = scen === 'post' ? 1 : N; // 木樁場景完全確定性,多跑無意義
      for (let s = 0; s < n; s++) {
        const r = runOne(id, mode, scen, 1000 + s * 7 + ids.indexOf(id));
        secs.push(r.ticks / 60);
        if (r.killed) killed++;
        bas += r.dmgBy.basic;
        tot += r.dmgBy.basic + r.dmgBy.special + r.dmgBy.ult;
      }
      per[id] = { mean: mean(secs), ci: ci(secs), med: med(secs), killed, n, basicShare: tot ? bas / tot : 0 };
    }
    table[scen + '/' + mode] = per;
  }
}
const f1 = (v) => v.toFixed(1);
console.log('\n[TTK 統計:殺死 500 血目標所需秒數,均值 ± 95% 信賴區間(對 AI n=' + N + '/格,木樁 n=1(確定性),未擊殺以 333 秒封頂計入)]');
for (const key of Object.keys(table)) {
  const per = table[key];
  const all = ids.map((id) => per[id].mean);
  console.log('\n## ' + key + '  全角色平均 ' + f1(mean(all)) + ' 秒(最快 ' + f1(Math.min(...all)) + ' / 最慢 ' + f1(Math.max(...all)) + ')  普攻傷害占比 ' + (mean(ids.map((id) => per[id].basicShare)) * 100).toFixed(0) + '%');
  console.log(ids.map((id) => id.padEnd(9) + f1(per[id].mean).padStart(6) + ' ±' + f1(per[id].ci).padStart(5) + ' 殺' + per[id].killed + '/' + per[id].n + ' 普占' + (per[id].basicShare * 100).toFixed(0) + '%').join('\n'));
}
console.log('\n模擬耗時 ' + ((Date.now() - T0) / 1000).toFixed(1) + ' 秒');

// ---------- 3. 模擬判定(取角色間中位數) ----------
const avgOf = (k) => med(ids.map((id) => table[k][id].mean)); // 用角色間中位數,避免機器人卡住的個別格(以 333 秒封頂)拉歪
const mx = avgOf('post/mixed');
const sp = avgOf('post/special');
const ba = avgOf('post/basic');
check('木樁:純普攻 > 混合 × 2(普攻一招鮮行不通)', ba > mx * 2, 'basic=' + f1(ba) + ' mixed=' + f1(mx));
check('木樁:純普攻 > 只必殺', ba > sp, 'basic=' + f1(ba) + ' special=' + f1(sp));
check('木樁:混合 ≤ 只必殺(混合最強)', mx <= sp * 1.05, 'mixed=' + f1(mx) + ' special=' + f1(sp));
check('木樁:純普攻每位 ≥ 60 秒', ids.every((id) => table['post/basic'][id].mean >= 60), ids.map((id) => id + ':' + f1(table['post/basic'][id].mean)).join(' '));
const axm = avgOf('ai/mixed');
const axb = avgOf('ai/basic');
check('對 AI:純普攻 > 混合 × 2', axb > axm * 2, 'basic=' + f1(axb) + ' mixed=' + f1(axm));

if (!REPORT) console.log('\n' + pass + ' passed, ' + fail + ' failed');
process.exit(fail ? 1 : 0);
