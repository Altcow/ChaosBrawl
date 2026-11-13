import { FX, px } from '../core/fixed.js';
import { takeHit } from './fighter.js';
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
    if (c.p && c.p.dead) continue;
    if (!canHit(c.log, c.d.id, c.key, c.itr, w.tick)) continue;
    const attX = c.p ? c.p.x : c.a.x;
    const r = takeHit(w, c.d, attX, c.itr, c.a.id, !!c.p);
    if (!r) continue;
    c.log[c.d.id] = { seq: c.key, tick: w.tick };
    if (c.p) c.p.dead = true;
    else c.a.hitstop = c.itr.stop;
    if (r === 'hit' && c.itr.gain) {
      const adef = w.defs[c.a.charId];
      c.a.mp = Math.min(adef.mp, c.a.mp + c.itr.gain * FX);
    }
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
