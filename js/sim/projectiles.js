import { toFx, px } from '../core/fixed.js';
import { boxRect, overlaps } from './box.js';

// 射彈 / 場地物件(書牆、安靜圈):獨立物件,有自己的 bdy / itr
export function spawnProjectile(w, owner, def, spec) {
  const pd = def.projectiles[spec.proj];
  if (!pd) return;
  w.projectiles.push({
    id: w.nextSeq++,
    owner: owner.id,
    ch: owner.charId,
    kind: spec.proj,
    x: owner.x + owner.face * toFx(spec.x || 0),
    y: owner.y + toFx(spec.y || 0),
    z: owner.z + toFx(spec.dz || 0),
    face: owner.face,
    vx: owner.face * pd.vx,
    vz: toFx(spec.vz || 0),
    life: pd.life,
    dead: false,
    hitLog: {}
  });
}

export function stepProjectiles(w) {
  for (const p of w.projectiles) {
    const pd = w.defs[p.ch].projectiles[p.kind];
    if (pd.zone) {
      for (const f of w.fighters) {
        if (f.id === p.owner || f.dead || f.team === w.fighters[p.owner].team) continue;
        if (Math.abs(px(f.x - p.x)) <= pd.zone.r && Math.abs(px(f.z - p.z)) <= pd.zone.zr) f.silence = Math.max(f.silence, 3);
      }
    }
    if (pd.chase > 0) {
      let best = null;
      let bd = 1 << 30;
      for (const f of w.fighters) {
        if (f.id === p.owner || f.dead || (w.mode.ff !== 2 && f.team === w.fighters[p.owner].team)) continue;
        const d = Math.abs(f.x - p.x);
        if (d < bd) {
          bd = d;
          best = f;
        }
      }
      if (best) {
        const dz = best.z - p.z;
        if (dz > pd.chase) p.z += pd.chase;
        else if (dz < -pd.chase) p.z -= pd.chase;
        else p.z = best.z;
      }
    }
    p.x += p.vx;
    p.z += p.vz;
    p.life--;
    if (p.life <= 0 || px(p.x) < 0 || px(p.x) > w.stage.w || px(p.z) < -20 || px(p.z) > w.stage.d + 20) p.dead = true;
  }
  // 書牆擋射彈
  for (const q of w.projectiles) {
    const qd = w.defs[q.ch].projectiles[q.kind];
    if (!qd.wall || q.dead) continue;
    const wr = boxRect(px(q.x), px(q.y), q.face, qd.bdy);
    for (const p of w.projectiles) {
      if (p === q || p.dead || w.fighters[p.owner].team === w.fighters[q.owner].team) continue;
      const pd = w.defs[p.ch].projectiles[p.kind];
      if (!pd.itr) continue;
      if (Math.abs(px(p.z - q.z)) > qd.bdy.zr) continue;
      if (overlaps(wr, boxRect(px(p.x), px(p.y), p.face, pd.itr))) p.dead = true;
    }
  }
  w.projectiles = w.projectiles.filter((p) => !p.dead);
}
