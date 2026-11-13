import { BIT } from '../core/input.js';
import { px } from '../core/fixed.js';
import { S, boomOut } from './fighter.js';
import { RAGE_MAX, ULT_MACRO } from './ult.js';
import { commandMacro } from './command.js';

// 電腦 AI(草案 4-2):只輸出「輸入位元組」,與真人走同一套程式。
// 反應延遲:AI 只看得到 delay tick 以前的場面快照(不作弊讀對方下一格)。
// delay = 400/250/150/80 ms ≈ 24/15/9/5 tick;防禦率 10/30/55/75%
export const LEVELS = [
  { name: '新手', delay: 24, def: 0.1, roll: 0, special: 0.05, zNoise: 30, juggle: false, skipInv: false, atkCd: 40, chain: 0.4, cap: true },
  { name: '普通', delay: 15, def: 0.3, roll: 0.15, special: 0.3, zNoise: 0, juggle: false, skipInv: true, atkCd: 26, chain: 0.75, cap: true },
  { name: '困難', delay: 9, def: 0.55, roll: 0.3, special: 0.6, zNoise: 0, juggle: true, skipInv: true, atkCd: 18, chain: 0.9, cap: false },
  { name: '魔王', delay: 5, def: 0.75, roll: 0.4, special: 0.9, zNoise: 0, juggle: true, skipInv: true, atkCd: 14, chain: 1, cap: false }
];
const CAP_PER_HUMAN = 2; // 同一真人最多被 2 個 AI 同時鎖定(新手、普通)

export function think(w, f) {
  if (f.kind === 'puncher') return thinkPuncher(w, f);
  if (f.kind === 'ai') return thinkAi(w, f);
  return 0;
}

// M1 簡易對手:走近對齊 z 後每 period tick 揮一次輕攻擊
function thinkPuncher(w, f) {
  const t = w.fighters[0];
  if (!t || t === f) return 0;
  const dx = px(t.x - f.x);
  const dz = px(t.z - f.z);
  let b = 0;
  if (Math.abs(dz) > 6) b |= dz > 0 ? BIT.DOWN : BIT.UP;
  if (Math.abs(dx) > 44) b |= dx > 0 ? BIT.RIGHT : BIT.LEFT;
  else if (Math.abs(dz) <= 8) {
    if (f.state === 0 || f.state === 1) f.face = dx >= 0 ? 1 : -1;
    f.ai.cd--;
    if (f.ai.cd <= 0) {
      b |= BIT.ATK;
      f.ai.cd = f.ai.period || 30;
    }
  }
  return b;
}

const NO_CONTROL = [S.HURT, S.FALL, S.LYING, S.GETUP, S.STUN, S.DEAD, S.SQUAT];

function pickTarget(w, f, L) {
  let best = -1;
  let bs = 1e9;
  for (const o of w.fighters) {
    if (o === f || o.dead || o.team === f.team) continue;
    if (L.cap && o.kind === 'human') {
      let n = 0;
      for (const a of w.fighters) if (a !== f && a.kind === 'ai' && a.ai.lvl <= 1 && a.ai.tgt === o.id) n++;
      if (n >= CAP_PER_HUMAN) continue;
    }
    let s = Math.abs(px(o.x - f.x)) + Math.abs(px(o.z - f.z)) * 2 + (o.hp / w.defs[o.charId].hp) * 150;
    if (f.lastAtk === o.id && w.tick - f.lastAtkTick < 180) s -= 120;
    if (s < bs) {
      bs = s;
      best = o.id;
    }
  }
  return best;
}

function thinkAi(w, f) {
  const ai = f.ai;
  const L = LEVELS[ai.lvl];
  const def = w.defs[f.charId];
  const info = def.ai || {};

  // 觀察(延遲 delay tick)
  ai.q.push(w.fighters.map((o) => [px(o.x), px(o.z), o.state, o.face, o.hf >= 0 ? 1 : 0]));
  while (ai.q.length > L.delay + 1) ai.q.shift();
  const seen = ai.q[0];

  if (f.dead || NO_CONTROL.indexOf(f.state) >= 0) {
    ai.script.length = 0;
    ai.defUntil = 0;
    ai.lastIn = 0;
    return 0;
  }
  if (ai.script.length) {
    ai.lastIn = ai.script.shift();
    return ai.lastIn;
  }

  if (ai.cdA > 0) ai.cdA--;
  if (ai.reactCd > 0) ai.reactCd--;
  if (ai.spT > 0) ai.spT--;
  if (w.tick % 60 === 0) ai.zOff = L.zNoise ? w.rng.int(L.zNoise * 2 + 1) - L.zNoise : 0;
  const tg = w.fighters[ai.tgt];
  if (ai.tgt < 0 || !tg || tg.dead || w.tick % 30 === 0) ai.tgt = pickTarget(w, f, L);
  const t = w.fighters[ai.tgt];
  if (!t) {
    ai.lastIn = 0;
    return 0;
  }

  const s = seen[ai.tgt] || seen[0];
  const mx = px(f.x);
  const mz = px(f.z);
  const dx = s[0] - mx;
  const dzRaw = s[1] - mz;
  const dz = dzRaw + ai.zOff;
  const adx = Math.abs(dx);
  const tdir = dx >= 0 ? BIT.RIGHT : BIT.LEFT;
  const facing = f.face > 0 === dx >= 0;
  const canAct = f.state === S.IDLE || f.state === S.WALK;

  // 威脅反應:看到對手出招且在射程內 → 依機率防禦 / 翻滾
  const faceMe = s[3] > 0 === mx > s[0];
  const threat = s[4] === 1 && adx <= 75 && Math.abs(dzRaw) <= 22 && faceMe;
  if (threat && ai.reactCd <= 0 && (canAct || f.state === S.DEFEND)) {
    ai.reactCd = 40;
    const r = w.rng.int(100) / 100;
    if (r < L.def) ai.defUntil = w.tick + 16;
    else if (r < L.def + L.roll && f.rollCd === 0) {
      ai.script = [BIT.DEF | tdir, BIT.DEF | tdir, BIT.DEF | tdir, BIT.DEF | tdir, 0];
      ai.lastIn = BIT.DEF;
      return BIT.DEF;
    }
  }
  if (ai.defUntil > w.tick) {
    ai.lastIn = BIT.DEF;
    return BIT.DEF;
  }

  // 大招:爆氣滿,且(範圍內敵人 >= n 或 HP < 30%且有敵人在範圍內);只用延遲後看到的位置
  if (canAct && def.hasUlt && w.ult.on && f.ult === 0 && f.rage >= RAGE_MAX && facing && (w.tick + f.id) % 15 === 0) {
    const u = info.ult || {};
    let n = 0;
    for (const o of w.fighters) {
      if (o === f || o.dead || o.team === f.team) continue;
      const so = seen[o.id];
      if (!so) continue;
      const ddx = (so[0] - mx) * f.face;
      if (ddx > 0 && ddx <= (u.range || 320) && Math.abs(so[1] - mz) <= (u.zr || 130)) n++;
    }
    if ((n >= (u.n || 2) || (n >= 1 && f.hp < def.hp * 0.3)) && w.rng.int(100) < Math.max(50, L.special * 100)) {
      ai.script = ULT_MACRO.slice();
      ai.lastIn = ai.script.shift();
      return ai.lastIn;
    }
  }

  let out = 0;
  const range = info.range || 44;
  const ranged = info.style === 'ranged';
  const aligned = Math.abs(dz) <= 8;
  if (!aligned) out |= dz > 0 ? BIT.DOWN : BIT.UP;
  if (ranged) {
    const away = tdir === BIT.RIGHT ? BIT.LEFT : BIT.RIGHT;
    const room = away === BIT.LEFT ? mx > 140 : mx < w.stage.w - 140;
    if (adx < 130 && room) out |= away;
    else if (adx > 260) out |= tdir;
  } else if (adx > range - 6) out |= tdir;

  const tState = s[2];
  const okTarget = !(L.skipInv && (tState === S.LYING || tState === S.GETUP || tState === S.DEAD)) && (tState !== S.FALL || L.juggle);

  // 必殺:每 15 tick 評估一次
  if (canAct && ai.spT <= 0 && facing && okTarget) {
    ai.spT = 15;
    if (w.rng.int(100) < L.special * 100 && info.specials) {
      for (const sp of info.specials) {
        const m = def.moves[sp.cmd];
        if (!m || f.mp < m.cost || f.silence > 0 || (m.boom && boomOut(w, f))) continue;
        if ((sp.hpBelow && f.hp >= def.hp * sp.hpBelow) || (sp.mpBelow && f.mp >= def.mp * sp.mpBelow)) continue; // 回血 / 回魔類:低於門檻才用
        if (adx >= sp.min && adx <= sp.max && Math.abs(dz) <= (sp.zr || 10)) {
          ai.script = commandMacro(sp.cmd, f.face);
          ai.lastIn = ai.script.shift();
          return ai.lastIn;
        }
      }
    }
  }

  if (aligned && okTarget && adx <= range && facing) {
    if (canAct && ai.cdA <= 0 && !(ai.lastIn & BIT.ATK)) {
      out |= BIT.ATK;
      ai.cdA = L.atkCd;
    } else if (f.state === S.ATTACK && f.move && !(ai.lastIn & BIT.ATK)) {
      const m = def.moves[f.move];
      if (ai.chainSeq !== f.mseq) {
        ai.chainSeq = f.mseq;
        ai.chainOk = w.rng.int(100) < L.chain * 100;
      }
      if (ai.chainOk && m.next && m.total - f.mtot <= m.cancel) out |= BIT.ATK;
    }
  } else if (!facing && adx <= range + 20 && canAct) {
    out |= tdir; // 轉向
  }
  ai.lastIn = out;
  return out;
}
