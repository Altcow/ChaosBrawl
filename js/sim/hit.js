import { FX, px } from '../core/fixed.js';
import { takeHit, startMove, atkPct, S } from './fighter.js';
import { RAGE_MAX, ULT_GUARD, ultCap } from './ult.js';
import { boxRect, overlaps } from './box.js';

export { boxRect, overlaps };

function canHit(log, targetId, seq, itr, tick) {
  const l = log[targetId];
  if (!l || l.seq !== seq) return true;
  return itr.rehit > 0 && tick - l.tick >= itr.rehit;
}

// 先收集全部命中候選、再依序套用,避免對撞時被座位順序偏袒
export function resolveHits(w) {
  const cands = [];
  for (const a of w.fighters) {
    if (a.hf < 0 || !a.hm || a.dead && a.state === 16) continue;
    const fr = w.defs[a.charId].moves[a.hm].frames[a.hf];
    if (!fr.itr) continue;
    for (const itr of fr.itr) {
      const ar = boxRect(px(a.x), px(a.y), a.face, itr);
      for (const d of w.fighters) {
        if (d === a || !friendlyOk(w, a, d, false)) continue;
        if (testGeom(w, ar, itr, px(a.z), d)) cands.push({ a, p: null, d, itr, key: a.mseq, log: a.hitLog });
      }
    }
  }
  for (const p of w.projectiles) {
    const pd = w.defs[p.ch].projectiles[p.kind];
    if (!pd.itr) continue;
    const ar = boxRect(px(p.x), px(p.y), p.face, pd.itr);
    for (const d of w.fighters) {
      if (d.id === p.owner || !friendlyOk(w, w.fighters[p.owner], d, true)) continue;
      if (testGeom(w, ar, pd.itr, px(p.z), d)) cands.push({ a: w.fighters[p.owner], p, d, itr: pd.itr, key: p.id, log: p.hitLog });
    }
  }
  for (const c of cands) {
    if (c.p && (c.p.dead || c.p.owner !== c.a.id)) continue; // 已被反彈改了主人的射彈,舊候選作廢
    if (!canHit(c.log, c.d.id, c.key, c.itr, w.tick)) continue;
    const attX = c.p ? c.p.x : c.a.x;
    const adef = w.defs[c.a.charId];
    // 反射(D16):架式格 reflect 的人把射彈原路彈回(換主人、反向、重置命中、清掉大招標記)
    if (c.p && c.d.state === S.SPECIAL && c.d.move && w.defs[c.d.charId].moves[c.d.move].frames[c.d.mf].reflect) {
      c.p.owner = c.d.id;
      c.p.face = -c.p.face;
      c.p.vx = -c.p.vx;
      c.p.hitLog = {};
      c.p.ult = 0;
      w.events.push({ t: 'reflect', x: c.p.x, y: c.p.y, z: c.p.z, a: c.a.id, d: c.d.id });
      continue;
    }
    // 鎖定招式:同一發動者一次只鎖一人
    if (c.itr.lock && c.a.move === c.itr.lock) continue;
    // 大招判定:每目標傷害上限、大招保護(3 s 內不吃其他大招傷害,控制照吃)、防住吃 25% + bdef 50
    const useq = c.p ? c.p.ult || 0 : c.a.ult === 2 && adef.moves[c.a.hm].ult ? c.a.ultSeq : 0;
    let itr = c.itr;
    let udmg = 0;
    if (!useq) {
      const pct = atkPct(c.a, adef); // 增益 / 被動攻擊倍率(D9)
      if (pct !== 100) itr = Object.assign({}, itr, { dmg: Math.round((itr.dmg * pct) / 100) });
    }
    if (useq) {
      const info = c.p ? adef.moves.ultimate.ult : adef.moves[c.a.hm].ult;
      const dealt = c.a.ultDmg[c.d.id] || 0;
      udmg = Math.min(itr.dmg, Math.max(0, ultCap(info) - dealt));
      if (c.d.ultGuard > 0 && c.d.ultGuardBy !== useq) udmg = 0;
      itr = Object.assign({}, itr, { dmg: udmg, bdef: 50, ult: true, unb: info.unblockable });
    }
    const r = takeHit(w, c.d, attX, itr, c.a.id, !!c.p);
    if (!r) continue;
    c.log[c.d.id] = { seq: c.key, tick: w.tick };
    if (c.p) {
      const ppd = w.defs[c.p.ch].projectiles[c.p.kind];
      if (!ppd.boomerang && !ppd.pierce) c.p.dead = true;
    } else c.a.hitstop = c.itr.stop;
    if (useq) {
      c.a.ultDmg[c.d.id] = (c.a.ultDmg[c.d.id] || 0) + udmg;
      if (r === 'hit' && udmg > 0) {
        c.d.ultGuard = ULT_GUARD;
        c.d.ultGuardBy = useq;
      }
    }
    if (r === 'hit' && c.itr.lock && adef.moves[c.itr.lock]) {
      // 鎖定(D13):打中第一人 → 發動者切到鎖定演出招式,對方被釘在身前
      c.d.held = c.a.id;
      startMove(c.a, adef, w, c.itr.lock, S.SPECIAL);
      c.a.vx = 0;
    }
    if (r === 'hit' && c.itr.gain) c.a.mp = Math.min(adef.mp, c.a.mp + c.itr.gain * FX);
    if (r === 'hit' && !useq && adef.hasUlt && w.ult.on) c.a.rage = Math.min(RAGE_MAX, c.a.rage + Math.floor((itr.dmg * FX * 2) / 10)); // 造成傷害每 10 點 +2;大招命中不加
    const ex = c.p ? c.p.x : c.d.x;
    w.events.push({ t: r, x: ex, y: c.d.y + 30 * FX, z: c.d.z, stop: c.itr.stop, big: c.itr.fall >= 60, a: c.a.id, d: c.d.id });
  }
  if (w.projectiles.length) w.projectiles = w.projectiles.filter((p) => !p.dead);
}

// 友軍傷害(草案 1-8):同隊且非自己才適用。0 = 全穿過;1 = 近戰穿過、射彈命中;2 = 全命中
function friendlyOk(w, a, d, isProj) {
  if (!a || a.team !== d.team) return true;
  const ff = w.mode.ff || 0;
  return ff === 2 || (ff === 1 && isProj);
}

function testGeom(w, ar, itr, az, d) {
  if (d.state === 16) return false; // DEAD
  const dz = Math.abs(az - px(d.z));
  if (dz > itr.zr) return false;
  const dr = boxRect(px(d.x), px(d.y), d.face, w.defs[d.charId].body);
  return overlaps(ar, dr);
}
